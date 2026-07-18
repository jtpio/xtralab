import type { JupyterFrontEnd } from '@jupyterlab/application';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { FileEditor } from '@jupyterlab/fileeditor';
import { NotebookPanel } from '@jupyterlab/notebook';
import type { EditorView } from '@codemirror/view';
import type { Widget } from '@lumino/widgets';

import type { IAskAgentContext, IAskAgentRequest } from './tokens';

/**
 * A CodeMirror view a selection can be asked about, plus the context needed
 * to describe it to an agent: the document path and, for notebooks, which
 * cell the view belongs to.
 */
export interface IEditorTarget {
  view: EditorView;
  path: string;
  cell?: {
    index: number;
    type: string;
  };
}

/**
 * Resolve the CodeMirror view a selection in `widget` would live in, or
 * `null` when the widget holds no such editor. Two widget shapes are
 * recognized:
 *
 * - a notebook panel, where the active cell carries the editor and
 *   `activeCellIndex` names its 0-based position in the nbformat `cells`
 *   array. A rendered markdown cell keeps its (hidden) editor, but a
 *   selection in the rendered HTML never passes {@link domSelectionInView},
 *   so no pill appears there; and
 * - a document widget whose content is a `FileEditor`. The wrapper is not
 *   checked with `instanceof DocumentWidget`: `@jupyterlab/docregistry` is
 *   not a core singleton, so another copy of the class could be in play.
 *   `FileEditor` and `NotebookPanel` come from singleton packages.
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
 * Whether the current DOM selection lives inside `view`. Guards the
 * selection-change listener against selections made elsewhere (a terminal,
 * a sidebar, another notebook cell) while the widget owning `view` happens
 * to be the shell's current widget.
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
 * current widget — a file editor or the active notebook cell — or return
 * `null` when that widget holds no CodeMirror document editor.
 *
 * With `allowEmpty`, a collapsed selection falls back to the cursor's line
 * (used by the command/shortcut path so it works without a mouse
 * selection); otherwise an empty selection yields `null`.
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
    // A selection that ends exactly at the start of a line (the common
    // "drag over whole lines" gesture) should not count that line.
    const endPos =
      main.to === state.doc.lineAt(main.to).from ? main.to - 1 : main.to;
    endLine = state.doc.lineAt(endPos).number;
    text = state.sliceDoc(main.from, main.to);
  }

  // Anchor the popup at the selection head (where the cursor ended up).
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
