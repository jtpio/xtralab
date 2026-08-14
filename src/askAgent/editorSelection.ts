import type { JupyterFrontEnd } from '@jupyterlab/application';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { FileEditor } from '@jupyterlab/fileeditor';
import { NotebookPanel } from '@jupyterlab/notebook';
import type { EditorView } from '@codemirror/view';
import type { Widget } from '@lumino/widgets';

import type { IAskAgentContext, IAskAgentRequest } from './tokens';

/**
 * A CodeMirror view a selection can be asked about, plus the document path
 * and, for notebooks, the owning cell.
 */
interface IEditorTarget {
  view: EditorView;
  path: string;
  cell?: {
    index: number;
    type: string;
  };
}

/**
 * Resolve the CodeMirror view a selection in `widget` would live in — the
 * active notebook cell or a `FileEditor` document — or `null`. The wrapper is
 * duck-typed, not `instanceof DocumentWidget`: `@jupyterlab/docregistry` is
 * not a core singleton, unlike `FileEditor` and `NotebookPanel`.
 */
export function resolveEditorTarget(
  widget: Widget | null
): IEditorTarget | null {
  if (widget instanceof NotebookPanel) {
    const cell = widget.content.activeCell;
    if (cell !== null && cell.editor instanceof CodeMirrorEditor) {
      return {
        view: cell.editor.editor,
        path: widget.context.path,
        cell: { index: widget.content.activeCellIndex, type: cell.model.type }
      };
    }
    return null;
  }

  const content = (widget as { content?: unknown } | null)?.content;
  if (
    content instanceof FileEditor &&
    content.editor instanceof CodeMirrorEditor
  ) {
    return { view: content.editor.editor, path: content.context.path };
  }

  return null;
}

/**
 * Whether the current DOM selection lives inside `view`; guards against
 * selections made elsewhere while the owning widget is current.
 */
export function domSelectionInView(
  view: EditorView,
  selection: Selection
): boolean {
  const node = selection.anchorNode;
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  return element !== null && view.dom.contains(element);
}

/**
 * Build an ask-agent request from the current selection in the shell's
 * current widget, or `null` when it holds no CodeMirror document editor.
 * With `allowEmpty`, a collapsed selection falls back to the cursor's line;
 * otherwise it yields `null`.
 */
export function editorAskRequest(
  app: JupyterFrontEnd,
  options: { allowEmpty?: boolean } = {}
): IAskAgentRequest | null {
  const target = resolveEditorTarget(app.shell.currentWidget);
  if (target === null) {
    return null;
  }

  const { view, path, cell } = target;
  const { state } = view;
  const main = state.selection.main;
  if (main.empty && options.allowEmpty !== true) {
    return null;
  }

  const startLine = state.doc.lineAt(main.from).number;
  let endLine: number;
  let text: string;
  if (main.empty) {
    endLine = startLine;
    text = state.doc.lineAt(main.from).text;
  } else {
    // A selection ending exactly at a line start (the whole-line drag
    // gesture) should not count that line.
    const endPos =
      main.to === state.doc.lineAt(main.to).from ? main.to - 1 : main.to;
    endLine = state.doc.lineAt(endPos).number;
    text = state.sliceDoc(main.from, main.to);
  }

  // `coordsAtPos` returns `null` for positions scrolled out of view.
  const coords = view.coordsAtPos(main.head);
  const anchor = coords
    ? new DOMRect(
        coords.left,
        coords.top,
        Math.max(1, coords.right - coords.left),
        Math.max(1, coords.bottom - coords.top)
      )
    : null;

  const context: IAskAgentContext = { path, startLine, endLine, text };
  if (cell !== undefined) {
    context.cell = cell;
  }
  return { context, anchor };
}
