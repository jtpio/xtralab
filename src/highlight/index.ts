import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { FileEditor } from '@jupyterlab/fileeditor';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { Widget } from '@lumino/widgets';

const PLUGIN_ID = 'xtralab:highlight';

/**
 * Highlight a contiguous range of lines, or clear every highlight. These are
 * the only two commands the plugin contributes; both are designed to be driven
 * by a coding agent over the MCP command bridge to walk a user through code.
 */
const HIGHLIGHT_LINES_COMMAND = 'xtralab:highlight-lines';
const CLEAR_HIGHLIGHTS_COMMAND = 'xtralab:clear-highlights';

/**
 * CodeMirror line-decoration class; styled in style/highlight.css.
 */
const HIGHLIGHT_LINE_CLASS = 'jp-xtralab-highlightLine';

/**
 * A CodeMirror effect carrying the 1-indexed, inclusive line range to
 * highlight, or `null` to clear the editor's highlights.
 */
const setHighlight = StateEffect.define<{
  start: number;
  end: number;
} | null>();

/**
 * Holds the highlight decorations for one editor. It is injected lazily (the
 * first time an editor is highlighted) via `StateEffect.appendConfig`, so
 * editors that are never highlighted pay nothing.
 */
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    // Keep decorations anchored as the user edits around them.
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setHighlight)) {
        continue;
      }
      if (effect.value === null) {
        decorations = Decoration.none;
        continue;
      }
      const { doc } = transaction.state;
      const lineDecoration = Decoration.line({ class: HIGHLIGHT_LINE_CLASS });
      const start = Math.max(1, Math.min(effect.value.start, doc.lines));
      const end = Math.max(start, Math.min(effect.value.end, doc.lines));
      const ranges = [];
      for (let line = start; line <= end; line++) {
        ranges.push(lineDecoration.range(doc.line(line).from));
      }
      decorations = Decoration.set(ranges);
    }
    return decorations;
  },
  provide: field => EditorView.decorations.from(field)
});

/**
 * Return the CodeMirror view backing a widget's file editor, or `null` when
 * the widget is not a CodeMirror-based text editor (a notebook, a terminal,
 * the settings editor, …).
 */
function viewForWidget(widget: Widget | null): EditorView | null {
  const content = (widget as { content?: unknown } | null)?.content;
  return content instanceof FileEditor &&
    content.editor instanceof CodeMirrorEditor
    ? content.editor.editor
    : null;
}

/**
 * Coerce a JSON command argument to a positive integer line number, falling
 * back to `fallback` when it is missing or not a finite number.
 */
function toLine(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Contribute `xtralab:highlight-lines` and `xtralab:clear-highlights`.
 *
 * The built-in command surface can open a file (`docmanager:open`) and move
 * the cursor to a line (`fileeditor:go-to-line`), but it cannot persistently
 * highlight a span of lines — `documentsearch:start` only marks text matches
 * and hijacks the find box. This plugin fills that gap with a CodeMirror line
 * decoration, so an agent can point at "lines 31–43 of src/index.ts" while it
 * narrates a walkthrough. `xtralab:highlight-lines` opens the file when needed,
 * scrolls the range into view, and replaces any previous highlight in that
 * editor; `xtralab:clear-highlights` removes every highlight.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Highlight line ranges in text editors to guide walkthroughs.',
  autoStart: true,
  requires: [IDocumentManager],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    docManager: IDocumentManager,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): void => {
    const { commands, shell } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // Editors that currently carry a highlight, so a single clear can reach
    // them all. Disposed editors are dropped on the next clear.
    const highlighted = new Set<EditorView>();

    const ensureField = (view: EditorView): void => {
      if (view.state.field(highlightField, false) === undefined) {
        view.dispatch({ effects: StateEffect.appendConfig.of(highlightField) });
      }
    };

    commands.addCommand(HIGHLIGHT_LINES_COMMAND, {
      label: trans.__('Highlight Lines'),
      caption: trans.__('Highlight a range of lines in a text editor'),
      // Advertise the argument shape so agents listing commands over the MCP
      // bridge can see how to call it, the same way core commands do.
      describedBy: {
        args: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Path of the file to highlight in, relative to the server root. Opened if needed; defaults to the active editor when omitted.'
            },
            line: {
              type: 'number',
              description: 'First line to highlight (1-indexed). Defaults to 1.'
            },
            endLine: {
              type: 'number',
              description:
                'Last line to highlight (1-indexed, inclusive). Defaults to `line` for a single line.'
            },
            reveal: {
              type: 'boolean',
              description:
                'Whether to scroll the highlighted range into view. Defaults to true.'
            }
          }
        }
      },
      execute: async args => {
        const line = toLine(args['line'], 1);
        const endLine = toLine(args['endLine'], line);
        const path =
          typeof args['path'] === 'string' ? args['path'] : undefined;
        const reveal = args['reveal'] !== false;

        // With a path, bind strictly to that document: never fall back to the
        // active widget, or an explicit path could silently highlight an
        // unrelated editor that happens to be focused.
        let widget: Widget | null;
        if (path) {
          // Fail fast on a missing path instead of opening a phantom widget
          // behind a blocking "file not found" dialog.
          try {
            await docManager.services.contents.get(path, { content: false });
          } catch {
            throw new Error(`xtralab: no file at "${path}"`);
          }
          const opened = docManager.openOrReveal(path);
          if (!opened) {
            throw new Error(`xtralab: could not open "${path}"`);
          }
          // Wait for the model and the editor view to be ready.
          await opened.context.ready;
          await opened.revealed;
          widget = opened;
        } else {
          widget = shell.currentWidget;
        }

        const view = viewForWidget(widget);
        if (!view) {
          throw new Error(
            path
              ? `xtralab: "${path}" is not open in a text editor`
              : 'xtralab: the active widget is not a text editor'
          );
        }

        const start = Math.min(line, endLine);
        const end = Math.max(line, endLine);
        ensureField(view);

        const lineCount = view.state.doc.lines;
        const anchor = view.state.doc.line(
          Math.max(1, Math.min(start, lineCount))
        ).from;
        const effects: StateEffect<unknown>[] = [
          setHighlight.of({ start, end })
        ];
        if (reveal) {
          effects.push(EditorView.scrollIntoView(anchor, { y: 'center' }));
        }
        view.dispatch({ effects });
        // Forget editors that have since been closed before tracking this one.
        for (const tracked of highlighted) {
          if (!tracked.dom.isConnected) {
            highlighted.delete(tracked);
          }
        }
        highlighted.add(view);

        return start === end
          ? trans.__('Highlighted line %1', start)
          : trans.__('Highlighted lines %1-%2', start, end);
      }
    });

    commands.addCommand(CLEAR_HIGHLIGHTS_COMMAND, {
      label: trans.__('Clear Highlights'),
      caption: trans.__('Remove all xtralab line highlights'),
      execute: () => {
        for (const view of highlighted) {
          try {
            if (view.state.field(highlightField, false) !== undefined) {
              view.dispatch({ effects: setHighlight.of(null) });
            }
          } catch {
            // The editor was disposed; nothing to clear.
          }
        }
        highlighted.clear();
      }
    });

    if (palette) {
      const category = trans.__('Other');
      palette.addItem({ command: HIGHLIGHT_LINES_COMMAND, category });
      palette.addItem({ command: CLEAR_HIGHLIGHTS_COMMAND, category });
    }
  }
};

export default plugin;
