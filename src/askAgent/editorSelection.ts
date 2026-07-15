import type { JupyterFrontEnd } from '@jupyterlab/application';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
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
 * Return the document path behind a widget, or `null` for widgets that are
 * not document widgets (duck-typed on `context.path`).
 */
function pathForWidget(widget: Widget | null): string | null {
  const path = (widget as { context?: { path?: unknown } } | null)?.context
    ?.path;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/**
 * Resolve the CodeMirror view a selection in `widget` would live in, or
 * `null` when the widget holds no such editor. Two shapes are recognized,
 * both duck-typed so the plugin depends on neither `@jupyterlab/fileeditor`
 * nor `@jupyterlab/notebook` (the highlight plugin resolves file editors
 * the same way):
 *
 * - a document widget whose `content.editor` is the CodeMirror editor
 *   (file editors), and
 * - a notebook panel, where the active cell carries the editor
 *   (`content.activeCell.editor`) and `content.activeCellIndex` names its
 *   0-based position in the nbformat `cells` array. A rendered markdown
 *   cell keeps its (hidden) editor, but a selection in the rendered HTML
 *   never passes {@link domSelectionInView}, so no pill appears there.
 */
export function resolveEditorTarget(
  widget: Widget | null
): IEditorTarget | null {
  const path = pathForWidget(widget);
  if (path === null) {
    return null;
  }

  const content = (widget as { content?: unknown } | null)?.content as
    | {
        editor?: unknown;
        activeCell?: { editor?: unknown; model?: { type?: unknown } };
        activeCellIndex?: unknown;
      }
    | undefined;

  if (content?.editor instanceof CodeMirrorEditor) {
    return { view: content.editor.editor, path };
  }

  const cellEditor = content?.activeCell?.editor;
  if (cellEditor instanceof CodeMirrorEditor) {
    const index = content?.activeCellIndex;
    const type = content?.activeCell?.model?.type;
    return {
      view: cellEditor.editor,
      path,
      cell: {
        index: typeof index === 'number' ? index : 0,
        type: typeof type === 'string' ? type : 'code'
      }
    };
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
