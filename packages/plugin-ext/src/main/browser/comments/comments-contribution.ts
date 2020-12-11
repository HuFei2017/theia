/********************************************************************************
 * Copyright (C) 2020 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { inject, injectable } from 'inversify';
import { CommentingRangeDecorator } from './comments-decorator';
import { EditorManager, EditorMouseEvent, EditorWidget } from '@theia/editor/lib/browser';
import { MonacoDiffEditor } from '@theia/monaco/lib/browser/monaco-diff-editor';
import { CommentThreadWidget } from './comment-thread-widget';
import { CommentsService, ICommentInfo } from './comments-service';
import { CommentThread } from '../../../common/plugin-api-rpc-model';
import { CommandRegistry, DisposableCollection, MenuModelRegistry } from '@theia/core/lib/common';
import { URI } from 'vscode-uri';
import { CommentsContextKeyService } from './comments-context-key-service';
import { ContextKeyService } from '@theia/core/lib/browser/context-key-service';

@injectable()
export class CommentsContribution {

    // private mouseDownInfo: { lineNumber: number } | undefined;
    private _addInProgress!: boolean;
    private _commentWidgets: CommentThreadWidget[];
    private _commentInfos: ICommentInfo[];
    private _pendingCommentCache: { [key: string]: { [key: string]: string } };
    private _emptyThreadsToAddQueue: [number, EditorMouseEvent | undefined][] = [];
    private _computePromise: Promise<Array<ICommentInfo | null>> | undefined;

    @inject(MenuModelRegistry) protected readonly menus: MenuModelRegistry;
    @inject(CommentsContextKeyService) protected readonly commentsContextKeyService: CommentsContextKeyService;
    @inject(ContextKeyService) protected readonly contextKeyService: ContextKeyService;
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;

    constructor(@inject(CommentingRangeDecorator) protected readonly rangeDecorator: CommentingRangeDecorator,
                @inject(CommentsService) protected readonly commentService: CommentsService,
                @inject(EditorManager) protected readonly editorManager: EditorManager) {
        this._commentWidgets = [];
        this._pendingCommentCache = {};
        this._commentInfos = [];
        this.commentService.onDidSetResourceCommentInfos(e => {
            const editor = this.getCurrentEditor();
            const editorURI = editor && editor.editor instanceof MonacoDiffEditor && editor.editor.diffEditor.getModifiedEditor().getModel();
            if (editorURI && editorURI.toString() === e.resource.toString()) {
                this.setComments(e.commentInfos.filter(commentInfo => commentInfo !== null));
            }
        });
        this.editorManager.onCreated(async widget => {
            const disposables = new DisposableCollection();
            const editor = widget.editor;
            if (editor instanceof MonacoDiffEditor) {
                const originalEditorModel = editor.diffEditor.getOriginalEditor().getModel();
                if (originalEditorModel) {
                    const originalComments = await this.commentService.getComments(originalEditorModel.uri);
                    if (originalComments) {
                        this.rangeDecorator.update(editor.diffEditor.getOriginalEditor(), <ICommentInfo[]>originalComments.filter(c => !!c));
                    }
                }
                const modifiedEditorModel = editor.diffEditor.getModifiedEditor().getModel();
                if (modifiedEditorModel) {
                    const modifiedComments = await this.commentService.getComments(modifiedEditorModel.uri);
                    if (modifiedComments) {
                        this.rangeDecorator.update(editor.diffEditor.getModifiedEditor(), <ICommentInfo[]>modifiedComments.filter(c => !!c));
                    }
                }
                disposables.push(editor.onMouseDown(e => this.onEditorMouseDown(e)));
                disposables.push(this.commentService.onDidUpdateCommentThreads(async e => {
                        const editorModel = this.editor && this.editor.getModel();
                        const editorURI = this.editor && editorModel && editorModel.uri;
                        if (!editorURI) {
                            return;
                        }

                        if (this._computePromise) {
                            await this._computePromise;
                        }

                        const commentInfo = this._commentInfos.filter(info => info.owner === e.owner);
                        if (!commentInfo || !commentInfo.length) {
                            return;
                        }

                        const added = e.added.filter(thread => thread.resource && thread.resource.toString() === editorURI.toString());
                        const removed = e.removed.filter(thread => thread.resource && thread.resource.toString() === editorURI.toString());
                        const changed = e.changed.filter(thread => thread.resource && thread.resource.toString() === editorURI.toString());

                        removed.forEach(thread => {
                            const matchedZones = this._commentWidgets.filter(zoneWidget => zoneWidget.owner === e.owner
                                && zoneWidget.commentThread.threadId === thread.threadId && zoneWidget.commentThread.threadId !== '');
                            if (matchedZones.length) {
                                const matchedZone = matchedZones[0];
                                const index = this._commentWidgets.indexOf(matchedZone);
                                this._commentWidgets.splice(index, 1);
                                matchedZone.dispose();
                            }
                        });

                        changed.forEach(thread => {
                            const matchedZones = this._commentWidgets.filter(zoneWidget => zoneWidget.owner === e.owner
                                && zoneWidget.commentThread.threadId === thread.threadId);
                            if (matchedZones.length) {
                                const matchedZone = matchedZones[0];
                                matchedZone.update();
                            }
                        });
                        added.forEach(thread => {
                            const pendingCommentText = this._pendingCommentCache[e.owner] && this._pendingCommentCache[e.owner][thread.threadId!];
                            this.displayCommentThread(e.owner, thread, pendingCommentText);
                            this._commentInfos.filter(info => info.owner === e.owner)[0].threads.push(thread);
                        });
                    })
                );
                editor.onDispose(() => {
                    disposables.dispose();
                });
                this.beginCompute();
            }
        });
    }

    private onEditorMouseDown(e: EditorMouseEvent): void {
        let mouseDownInfo = null;

        const range = e.target.range;

        if (!range) {
            return;
        }

        // if (!e.event.leftButton) {
        //     return;
        // }

        if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
            return;
        }

        const data = e.target.detail;
        const gutterOffsetX = data.offsetX - data.glyphMarginWidth - data.lineNumbersWidth - data.glyphMarginLeft;

        // don't collide with folding and git decorations
        if (gutterOffsetX > 14) {
            return;
        }

        mouseDownInfo = { lineNumber: range.start };

        const { lineNumber } = mouseDownInfo;
        mouseDownInfo = null;

        if (!range || range.start !== lineNumber) {
            return;
        }

        if (!e.target.element) {
            return;
        }

        if (e.target.element.className.indexOf('comment-diff-added') >= 0) {
            this.addOrToggleCommentAtLine(e.target.position!.line + 1, e);
        }
    }

    private async beginCompute(): Promise<void> {
        const editorModel = this.editor && this.editor.getModel();
        const editorURI = this.editor && editorModel && editorModel.uri;
        if (editorURI) {
            const comments = await this.commentService.getComments(editorURI);
            this.setComments(<ICommentInfo[]>comments.filter(c => !!c));
        }
    }

    private setComments(commentInfos: ICommentInfo[]): void {
        if (!this.editor) {
            return;
        }

        this._commentInfos = commentInfos;
    }

    get editor(): monaco.editor.IStandaloneCodeEditor | undefined {
        const editor = this.getCurrentEditor();
        if (editor && editor.editor instanceof MonacoDiffEditor) {
            return  editor.editor.diffEditor.getModifiedEditor();
        }
    }

    private displayCommentThread(owner: string, thread: CommentThread, pendingComment: string | undefined): void {
        const editor = this.editor;
        if (editor) {
            const provider = this.commentService.getCommentController(owner);
            if (provider) {
                this.commentsContextKeyService.commentController.set(provider.id);
            }
            const zoneWidget = new CommentThreadWidget(editor, owner, thread, this.commentService, this.menus, this.commentsContextKeyService, this.commands);
            zoneWidget.display({ afterLineNumber: thread.range.startLineNumber, heightInLines: 5 });
            const currentEditor = this.getCurrentEditor();
            if (currentEditor) {
                currentEditor.onDispose(() => zoneWidget.dispose());
            }
            this._commentWidgets.push(zoneWidget);
        }
    }

    // private onEditorMouseDown(e: EditorMouseEvent): void {
    //
    //     if (e.target.element && e.target.element.className.indexOf('comment-diff-added') >= 0) {
    //         const lineNumber = e.target.position!.line;
    //         this.addOrToggleCommentAtLine(lineNumber, e);
    //     }
    // }

    public async addOrToggleCommentAtLine(lineNumber: number, e: EditorMouseEvent | undefined): Promise<void> {
        // If an add is already in progress, queue the next add and process it after the current one finishes to
        // prevent empty comment threads from being added to the same line.
        if (!this._addInProgress) {
            this._addInProgress = true;
            // The widget's position is undefined until the widget has been displayed, so rely on the glyph position instead
            const existingCommentsAtLine = this._commentWidgets.filter(widget => widget.getGlyphPosition() === lineNumber);
            if (existingCommentsAtLine.length) {
                // existingCommentsAtLine.forEach(widget => widget.toggleExpand(lineNumber));
                this.processNextThreadToAdd();
                return;
            } else {
                this.addCommentAtLine(lineNumber, e);
            }
        } else {
            this._emptyThreadsToAddQueue.push([lineNumber, e]);
        }
    }

    private processNextThreadToAdd(): void {
        this._addInProgress = false;
        const info = this._emptyThreadsToAddQueue.shift();
        if (info) {
            this.addOrToggleCommentAtLine(info[0], info[1]);
        }
    }

    private getCurrentEditor(): EditorWidget | undefined {
        return  this.editorManager.currentEditor;
    }

    public addCommentAtLine(lineNumber: number, e: EditorMouseEvent | undefined): Promise<void> {
        const newCommentInfos = this.rangeDecorator.getMatchedCommentAction(lineNumber);
        const editor = this.getCurrentEditor();
        if (!editor) {
            return Promise.resolve();
        }
        if (!newCommentInfos.length) {
            return Promise.resolve();
        }

        if (newCommentInfos.length > 1) {
            if (e) {
                // const anchor = { x: e.event.posx, y: e.event.posy };

                // this.contextMenuService.showContextMenu({
                //     getAnchor: () => anchor,
                //     getActions: () => this.getContextMenuActions(newCommentInfos, lineNumber),
                //     getActionsContext: () => newCommentInfos.length ? newCommentInfos[0] : undefined,
                //     onHide: () => { this._addInProgress = false; }
                // });

                return Promise.resolve();
            } else {
                // const picks = this.getCommentProvidersQuickPicks(newCommentInfos);
                // return this.quickInputService.pick(picks, { placeHolder: nls.localize('pickCommentService', "Select Comment Provider"),
                // matchOnDescription: true }).then(pick => {
                //     if (!pick) {
                //         return;
                //     }
                //
                //     const commentInfos = newCommentInfos.filter(info => info.ownerId === pick.id);
                //
                //     if (commentInfos.length) {
                //         const { ownerId } = commentInfos[0];
                //         this.addCommentAtLine2(lineNumber, ownerId);
                //     }
                // }).then(() => {
                //     this._addInProgress = false;
                // });
            }
        } else {
            const { ownerId } = newCommentInfos[0]!;
            this.addCommentAtLine2(lineNumber, ownerId);
        }

        return Promise.resolve();
    }

    public addCommentAtLine2(lineNumber: number, ownerId: string): void {
        // const editor = this.getCurrentEditor();
        // if (!editor) {
        //     return;
        // }
        // const range = new Range(lineNumber, 1, lineNumber, 1);
        const editorModel = this.editor && this.editor.getModel();
        const editorURI = this.editor && editorModel && editorModel.uri;
        if (editorURI) {
            this.commentService.createCommentThreadTemplate(ownerId, URI.parse(editorURI.toString()), {
                startLineNumber: lineNumber,
                endLineNumber: lineNumber,
                startColumn: 1,
                endColumn: 1
            });
            this.processNextThreadToAdd();
        }
    }
}
