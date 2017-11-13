/* global define, $, config */
"use strict";

define(function(require, exports, module) {
	// deps
	const ExtensionManager = require('core/extensionManager');
	const EditorEditors = require('modules/editor/ext/editors');
	const EditorSplit = require('modules/editor/ext/split');
	
	// libs
	const TokenIterator = require('ace/token_iterator').TokenIterator;
	const Range = require('ace/range').Range;
	
	class Extension extends ExtensionManager.Extension {
		constructor() {
			super({
				name: 'html-tools',
			});
			
			this.onSessionChange = this.onSessionChange.bind(this);
			this.onEditorBuild = this.onEditorBuild.bind(this);
		}
		
		
		init() {
			super.init();
			
			EditorEditors.on('session.beforeChange', this.onSessionChange);
			EditorEditors.on('build', this.onEditorBuild);
			
			// add shortcut to active editors
			EditorSplit.splitCall(split => {
				split.editor && this.onEditorBuild(split);
			});
			
			this.emit('init');
		}
		
		destroy() {
			super.destroy();
			
			EditorEditors.off('session.beforeChange', this.onSessionChange);
			EditorEditors.off('build', this.onEditorBuild);
			
			EditorSplit.splitCall(split => {
				split.editor && split.editor.commands.removeCommand('htmlTagWrap');
			});
		}
		
		onEditorBuild(split) {
			split.editor.commands.addCommand({
				name: 'htmlTagWrap',
				bindKey: {win: 'Alt-W', mac: 'Alt-W'},
				readOnly: false,
				exec: (edt) => {
					this.wrapTag(edt);
				}
			});
		}
		
		wrapTag(editor) {
			if (editor.session.$mode.$id !== 'ace/mode/html') {
				return;
			}
			
			let selection = editor.selection.getAllRanges();
			
			if (selection.length > 1 || selection[0].isEmpty()) {
				return;
			}
			
			selection = selection[0];
			
			let deltas = [{
				action: 'insert',
				lines: ['</p>'],
				start: {
					row: selection.end.row,
					column: selection.end.column,
				},
				end: {
					row: selection.end.row,
					column: selection.end.column + 4,
				}
			}, {
				action: 'insert',
				lines: ['<p>'],
				start: {
					row: selection.start.row,
					column: selection.start.column,
				},
				end: {
					row: selection.start.row,
					column: selection.start.column + 3,
				}
			}];
			
			editor.session.doc.applyDeltas(deltas);
			
			let selectionOpen = {
				row: selection.start.row,
				column: selection.start.column + 1,
			};
			
			let selectionClose = {
				row: selection.end.row,
				column: selection.end.column + 3 + 2,
			};
			
			if (selection.start.row !== selection.end.row) {
				editor.moveCursorTo(selection.end.row, selection.end.column);
				editor.clearSelection();
				editor.insert('\n');
				
				editor.moveCursorTo(selection.start.row, selection.start.column + 3);
				editor.clearSelection();
				editor.insert('\n');
				
				let tabDeltas = [];
				// 1 line for <p> and new line is auto indented
				let startRow = selection.start.row + 2;
				// 1 line for <p>
				let endRow = selection.end.row + 1;
				let tabString = editor.session.getTabString();
				
				for (let i = startRow; i <= endRow; i++) {
					if (editor.session.doc.getLine(i)) {
						tabDeltas.push({
							action: 'insert',
							lines: [tabString],
							start: {
								row: i,
								column: 0,
							},
							end: {
								row: i,
								column: tabString.length,
							}
						});
					}
				}
				
				if (tabDeltas.length) {
					editor.session.doc.applyDeltas(tabDeltas);
				}
				
				selectionClose.row += 2;
				selectionClose.column = selectionOpen.column + 1;
			}
			
			editor.moveCursorTo(selectionOpen.row, selectionOpen.column);
			editor.clearSelection();
			editor.selection.addRange(Range.fromPoints(selectionOpen, {
				row: selectionOpen.row,
				column: selectionOpen.column + 1,
			}));
			editor.selection.addRange(Range.fromPoints(selectionClose, {
				row: selectionClose.row,
				column: selectionClose.column + 1,
			}));
		}
		
		onSessionChange(session, e) {
			if (session.modeAtCursor !== 'html' || e.ignoreChanges || e.isUndo
			|| session.data.selection.getAllRanges().length > 1 || session.data.selection.ranges === null) {
				return;
			}
			
			if (e.data.lines.length > 1 || e.data.lines[0].match(/([^a-zA-Z0-9]+)/)) {
				return;
			}
			
			let tags = this.findTags(session.data, e.data.start, e.data);
			
			if (!tags) {
				return;
			}
			
			let columnDiff = e.data.start.column - tags[0].column;
			
			let delta = {
				action: e.data.action,
				lines: e.data.lines.slice(0),
				start: {
					row: tags[1].row,
					column: tags[1].column + columnDiff,
				},
				end: {
					row: tags[1].row,
					column: tags[1].column + columnDiff + (e.data.end.column - e.data.start.column),
				}
			};
			
			session.ignoreChanges = true;
			session.data.doc.applyDelta(delta, true);
			session.ignoreChanges = false;
		}
		
		findTags(session, pos, delta) {
			var iterator = new TokenIterator(session, pos.row, pos.column);
			var token = iterator.getCurrentToken();

			if (!token || !/\b(?:tag-open|tag-name)/.test(token.type)) {
				return;
			}
			
			var origPrevToken = token;
			if (token.type.indexOf("tag-open") != -1) {
				token = iterator.stepForward();
				if (!token) {
					return;
				}
			}
			
			var row = iterator.getCurrentTokenRow();
			var column = iterator.getCurrentTokenColumn();
			
			var origToken = token;
			var tag = token.value;
			var depth = 0;
			var prevToken = iterator.stepBackward();
			
			if (delta) {
				let index = delta.start.column - column;
				tag = tag.substr(0, index) + (delta.action === 'remove' ? delta.lines[0] : '') + tag.substr(index + (delta.action === 'insert' ? delta.lines[0].length : 0));
			}
			
			if (prevToken.value == '<') {
				//find closing tag
				do {
					prevToken = token;
					token = iterator.stepForward();

					if (token && token.value === tag && token.type.indexOf('tag-name') !== -1) {
						if (prevToken.value === '<') {
							depth++;
						} else if (prevToken.value === '</') {
							depth--;
						}
					}

				} while (token && depth >= 0);
			} else {
				//find opening tag
				do {
					token = prevToken;
					prevToken = iterator.stepBackward();

					if (token && token.value === tag && token.type.indexOf('tag-name') !== -1) {
						if (prevToken.value === '<') {
							depth++;
						} else if (prevToken.value === '</') {
							depth--;
						}
					}
				} while (prevToken && depth <= 0);

				//select tag again
				iterator.stepForward();
			}

			if (!token || token.value !== tag) {
				return;
			}
			
			return [{
				row: row,
				column: column,
				token: origToken
			}, {
				row: iterator.getCurrentTokenRow(),
				column: iterator.getCurrentTokenColumn(),
				token: token
			}];
		}
	}
	
	module.exports = new Extension();
});