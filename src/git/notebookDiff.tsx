import * as React from 'react';

import type * as nbformat from '@jupyterlab/nbformat';
import { OutputAreaModel, SimplifiedOutputArea } from '@jupyterlab/outputarea';
import { IRenderMimeRegistry, MimeModel } from '@jupyterlab/rendermime';
import { MessageLoop } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import { FileDiff } from '@pierre/diffs/react';
import {
  parseDiffFromFile,
  type DiffsThemeNames,
  type FileContents,
  type FileDiffMetadata
} from '@pierre/diffs';

/**
 * The CSS class added to the root of the notebook diff. Selectors that
 * style cell sections, headers, and the per-cell diff blocks hang off this
 * class.
 */
export const NOTEBOOK_DIFF_CSS_CLASS = 'jp-xtralab-NotebookDiff';

/**
 * Minimal slice of nbformat 4.x that the diff inspects. Fields we don't
 * read (attachments, e.g.) are intentionally not narrowed — we still pass
 * them around as part of the cell, but we never project them into the diff.
 */
export interface INotebookCell {
  cell_type: string;
  id?: string;
  source: string | string[];
  outputs?: INotebookOutput[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  attachments?: Record<string, unknown>;
}

export interface INotebookOutput {
  output_type: string;
  data?: Record<string, unknown>;
  text?: string | string[];
  name?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

export interface INotebook {
  cells: INotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

/**
 * One entry in the per-cell diff. `unchanged` cells are rendered as a
 * collapsed summary; the other variants render their source / outputs /
 * metadata via {@link FileDiff}. The `modified` and `unchanged` branches
 * carry the same payload but live on separate union members so `Extract`
 * narrowing works on `kind` literals downstream.
 */
export type NotebookCellDiff =
  | {
      kind: 'modified';
      oldCell: INotebookCell;
      newCell: INotebookCell;
      newIndex: number;
      oldIndex: number;
    }
  | {
      kind: 'unchanged';
      oldCell: INotebookCell;
      newCell: INotebookCell;
      newIndex: number;
      oldIndex: number;
    }
  | {
      kind: 'added';
      newCell: INotebookCell;
      newIndex: number;
    }
  | {
      kind: 'removed';
      oldCell: INotebookCell;
      oldIndex: number;
    };

/**
 * Notebook-level diff result returned by {@link buildNotebookDiff}. Returns
 * `null` from the builder when either side fails to parse — the caller then
 * falls back to a raw JSON file diff.
 */
export interface INotebookDiffResult {
  oldNotebook: INotebook;
  newNotebook: INotebook;
  cells: NotebookCellDiff[];
  /**
   * Kernel language pulled from `metadata.language_info.name`, used to pick
   * a syntax-highlighting filename for code cells.
   */
  language: string | undefined;
  /**
   * Pre-computed diff for notebook-level metadata (kernelspec, language_info,
   * nbformat) when it differs between revisions; `null` otherwise so the
   * section can be hidden without further checks.
   */
  notebookMetadataDiff: FileDiffMetadata | null;
}

/**
 * Parse notebook JSON. Returns `null` if the text doesn't parse or doesn't
 * look like a notebook (missing `cells` array). The caller falls back to a
 * raw text diff so a malformed file is still inspectable.
 */
export function parseNotebook(text: string): INotebook | null {
  if (text.length === 0) {
    return emptyNotebook();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    !Array.isArray((value as { cells?: unknown }).cells)
  ) {
    return null;
  }
  const nb = value as INotebook;
  if (nb.metadata === undefined || typeof nb.metadata !== 'object') {
    nb.metadata = {};
  }
  return nb;
}

function emptyNotebook(): INotebook {
  return {
    cells: [],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  };
}

/**
 * nbformat allows multiline string fields (`source`, stream `text`,
 * `text/plain` outputs, …) to be either a single string or an array of
 * strings. Normalize to one string so equality checks and diffs see the
 * same shape regardless of how the writer chose to serialise it.
 */
export function joinMultiline(value: string | string[] | undefined): string {
  if (value === undefined) {
    return '';
  }
  return Array.isArray(value) ? value.join('') : value;
}

export function cellSource(cell: INotebookCell): string {
  return joinMultiline(cell.source);
}

/**
 * Canonical text representation of a cell's outputs, used both for equality
 * checks and for the per-cell output diff. Stream and `text/plain` data
 * round-trip verbatim; richer mime types (image/png, text/html, …) collapse
 * to a `<mime-type>` placeholder so diffing image bytes doesn't drown the
 * panel in base64 noise.
 */
export function canonicalOutputs(cell: INotebookCell): string {
  const outputs = cell.outputs ?? [];
  if (outputs.length === 0) {
    return '';
  }
  return outputs.map(formatOutput).join('\n');
}

function formatOutput(output: INotebookOutput): string {
  switch (output.output_type) {
    case 'stream': {
      const stream = output.name ?? 'stdout';
      return `[stream:${stream}]\n${joinMultiline(output.text)}`;
    }
    case 'execute_result':
    case 'display_data': {
      const data = output.data ?? {};
      const lines: string[] = [];
      const tag =
        output.output_type === 'execute_result'
          ? `[execute_result:${output.execution_count ?? '?'}]`
          : '[display_data]';
      lines.push(tag);
      if ('text/plain' in data) {
        lines.push(
          joinMultiline(data['text/plain'] as string | string[] | undefined)
        );
      }
      const otherKeys = Object.keys(data)
        .filter(key => key !== 'text/plain')
        .sort();
      for (const key of otherKeys) {
        lines.push(`<${key}>`);
      }
      return lines.join('\n');
    }
    case 'error': {
      const ename = output.ename ?? 'Error';
      const evalue = output.evalue ?? '';
      // Tracebacks contain ANSI escape codes by default. Strip them so the
      // diff stays readable — coloring information has no analog in a plain
      // text diff, and the escapes themselves would inflate every traceback
      // line into a fake change.
      const traceback = (output.traceback ?? []).map(stripAnsi).join('\n');
      return `[error]\n${ename}: ${evalue}\n${traceback}`;
    }
    default:
      return `[${output.output_type}]`;
  }
}

// Matching ANSI escape codes inherently requires a control character in
// the pattern, which is what no-control-regex flags. Disable the rule on
// this single literal — silently emitting un-stripped escapes would just
// reintroduce the very noise stripAnsi exists to remove.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, '');
}

/**
 * Stable JSON of the cell's `metadata` object. Keys are sorted recursively
 * so a writer that re-orders the metadata object doesn't surface as a diff.
 * An empty metadata object returns the empty string so freshly-added cells
 * that carry the default `{}` don't produce a `+{}` placeholder section.
 */
export function canonicalMetadata(cell: INotebookCell): string {
  const md = cell.metadata ?? {};
  if (Object.keys(md).length === 0) {
    return '';
  }
  return stableStringify(md);
}

/**
 * Stable JSON of the notebook-level metadata bundle (kernelspec, language
 * info, nbformat). We diff the bundle as a single block so the user sees
 * all environment-level changes in one place.
 */
export function canonicalNotebookMetadata(notebook: INotebook): string {
  return stableStringify({
    metadata: notebook.metadata,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortKeysReplacer, 2);
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = (value as Record<string, unknown>)[key];
    }
    return sorted;
  }
  return value;
}

/**
 * Equality check used to classify matched cells as `unchanged` vs
 * `modified`. Compares the three things we actually render — type, source,
 * outputs, metadata — using the same canonical representations the diff
 * itself sees, so an "equal" verdict here implies all per-cell diff blocks
 * would be empty.
 */
export function cellsAreEqual(a: INotebookCell, b: INotebookCell): boolean {
  return (
    a.cell_type === b.cell_type &&
    cellSource(a) === cellSource(b) &&
    canonicalOutputs(a) === canonicalOutputs(b) &&
    canonicalMetadata(a) === canonicalMetadata(b)
  );
}

/**
 * Align cells between two notebook revisions. Cells that carry a stable id
 * (nbformat ≥ 4.5) match on their id; remaining cells fall back to
 * positional matching against the next un-consumed unidentified old cell so
 * older notebooks still produce a sensible diff.
 *
 * Output ordering: entries follow new-file order, with cells that exist
 * only in the old revision appended at the end as `removed`. We don't try
 * to interleave removals at their original position — for typical notebook
 * edits this is more readable than guessing alignment between unrelated
 * insertions and deletions.
 */
export function alignNotebookCells(
  oldCells: INotebookCell[],
  newCells: INotebookCell[]
): NotebookCellDiff[] {
  const oldById = new Map<string, number>();
  oldCells.forEach((cell, index) => {
    if (cell.id !== undefined && cell.id.length > 0) {
      oldById.set(cell.id, index);
    }
  });

  const consumed = new Set<number>();
  const entries: NotebookCellDiff[] = [];

  // Cursor used for positional matching of unidentified cells. Only advances
  // forward so we don't double-match a single old cell.
  let positionalCursor = 0;

  for (let newIndex = 0; newIndex < newCells.length; newIndex++) {
    const newCell = newCells[newIndex];
    let matchedOldIndex: number | undefined;
    if (newCell.id !== undefined && newCell.id.length > 0) {
      const candidate = oldById.get(newCell.id);
      if (candidate !== undefined && !consumed.has(candidate)) {
        matchedOldIndex = candidate;
      }
    } else {
      while (positionalCursor < oldCells.length) {
        const candidateIndex = positionalCursor;
        positionalCursor += 1;
        if (consumed.has(candidateIndex)) {
          continue;
        }
        const candidate = oldCells[candidateIndex];
        if (candidate.id === undefined || candidate.id.length === 0) {
          matchedOldIndex = candidateIndex;
          break;
        }
      }
    }

    if (matchedOldIndex !== undefined) {
      consumed.add(matchedOldIndex);
      const oldCell = oldCells[matchedOldIndex];
      const kind: 'unchanged' | 'modified' = cellsAreEqual(oldCell, newCell)
        ? 'unchanged'
        : 'modified';
      entries.push({
        kind,
        oldCell,
        newCell,
        oldIndex: matchedOldIndex,
        newIndex
      });
    } else {
      entries.push({ kind: 'added', newCell, newIndex });
    }
  }

  oldCells.forEach((oldCell, oldIndex) => {
    if (!consumed.has(oldIndex)) {
      entries.push({ kind: 'removed', oldCell, oldIndex });
    }
  });

  return entries;
}

export interface IBuildNotebookDiffOptions {
  oldText: string;
  newText: string;
}

/**
 * Build a complete notebook diff from the textual contents of two
 * revisions. Returns `null` if either side fails to parse as a notebook;
 * the caller is expected to fall back to a raw text diff in that case.
 *
 * An empty string on either side is treated as an empty notebook (no
 * cells, default metadata) so a freshly-added or deleted notebook still
 * produces a sensible cell-by-cell diff.
 */
export function buildNotebookDiff(
  options: IBuildNotebookDiffOptions
): INotebookDiffResult | null {
  const oldNotebook = parseNotebook(options.oldText);
  const newNotebook = parseNotebook(options.newText);
  if (oldNotebook === null || newNotebook === null) {
    return null;
  }
  const language = detectLanguage(newNotebook) ?? detectLanguage(oldNotebook);
  const cells = alignNotebookCells(oldNotebook.cells, newNotebook.cells);
  const oldMd = canonicalNotebookMetadata(oldNotebook);
  const newMd = canonicalNotebookMetadata(newNotebook);
  let notebookMetadataDiff: FileDiffMetadata | null = null;
  if (oldMd !== newMd) {
    notebookMetadataDiff = parseDiffFromFile(
      { name: 'notebook-metadata.json', contents: oldMd },
      { name: 'notebook-metadata.json', contents: newMd }
    );
  }
  return {
    oldNotebook,
    newNotebook,
    cells,
    language,
    notebookMetadataDiff
  };
}

function detectLanguage(notebook: INotebook): string | undefined {
  const li = notebook.metadata?.language_info as { name?: unknown } | undefined;
  if (li !== undefined && typeof li.name === 'string') {
    return li.name;
  }
  return undefined;
}

/**
 * Pick a filename whose extension drives `@pierre/diffs`'s syntax
 * highlighter. The library never reads the file from disk — `name` only
 * influences token-level rendering, so any plausible extension that maps
 * to the right language is fine.
 */
function cellFilename(
  cell: INotebookCell,
  language: string | undefined
): string {
  if (cell.cell_type === 'markdown') {
    return 'cell.md';
  }
  if (cell.cell_type === 'raw') {
    return 'cell.txt';
  }
  switch ((language ?? '').toLowerCase()) {
    case 'python':
      return 'cell.py';
    case 'javascript':
    case 'node':
      return 'cell.js';
    case 'typescript':
      return 'cell.ts';
    case 'r':
      return 'cell.r';
    case 'julia':
      return 'cell.jl';
    case 'rust':
      return 'cell.rs';
    case 'bash':
    case 'sh':
      return 'cell.sh';
    default:
      return 'cell.txt';
  }
}

/**
 * Build the FileContents pair the diff library wants. `kind` controls the
 * filename so each per-cell sub-diff (source, metadata) gets the right
 * extension and therefore the right highlighter.
 */
function pierreFiles(
  kind: 'source' | 'metadata',
  oldText: string,
  newText: string,
  oldCell: INotebookCell | null,
  newCell: INotebookCell | null,
  language: string | undefined
): { oldFile: FileContents; newFile: FileContents } {
  let name: string;
  if (kind === 'metadata') {
    name = 'cell-metadata.json';
  } else {
    // Use the new cell's type/language when available; fall back to the old
    // side so a deleted cell still gets the right highlighter.
    const reference = newCell ?? oldCell;
    name = reference !== null ? cellFilename(reference, language) : 'cell.txt';
  }
  return {
    oldFile: { name, contents: oldText },
    newFile: { name, contents: newText }
  };
}

interface ICellSubDiff {
  kind: 'source' | 'metadata';
  metadata: FileDiffMetadata;
}

/**
 * Compute the source / metadata sub-diffs for a single cell entry.
 * Returns the empty list for `unchanged` entries so the caller can collapse
 * them; for `added` / `removed` entries the populated side is paired with
 * an empty counterpart so the library treats every line as an addition or
 * deletion respectively.
 *
 * Outputs are deliberately *not* included here — they're rendered through
 * rendermime side-by-side in {@link OutputsSection} so images render as
 * images, HTML as HTML, etc. The canonical text form survives for equality
 * (it drives the `unchanged` classification) but not for display.
 */
function buildCellSubDiffs(
  entry: NotebookCellDiff,
  language: string | undefined
): ICellSubDiff[] {
  if (entry.kind === 'unchanged') {
    return [];
  }
  const oldCell = entry.kind === 'added' ? null : entry.oldCell;
  const newCell = entry.kind === 'removed' ? null : entry.newCell;

  const oldSource = oldCell !== null ? cellSource(oldCell) : '';
  const newSource = newCell !== null ? cellSource(newCell) : '';
  const oldMd = oldCell !== null ? canonicalMetadata(oldCell) : '';
  const newMd = newCell !== null ? canonicalMetadata(newCell) : '';

  const subdiffs: ICellSubDiff[] = [];
  const sections: Array<{
    kind: 'source' | 'metadata';
    oldText: string;
    newText: string;
  }> = [
    { kind: 'source', oldText: oldSource, newText: newSource },
    { kind: 'metadata', oldText: oldMd, newText: newMd }
  ];
  for (const section of sections) {
    if (section.oldText === section.newText) {
      continue;
    }
    const { oldFile, newFile } = pierreFiles(
      section.kind,
      section.oldText,
      section.newText,
      oldCell,
      newCell,
      language
    );
    subdiffs.push({
      kind: section.kind,
      metadata: parseDiffFromFile(oldFile, newFile)
    });
  }

  return subdiffs;
}

/**
 * Common diff library options shared across every per-cell sub-diff and
 * the notebook-level metadata diff. Split mode matches the file-diff path
 * and gives the user the same left=old / right=new mental model inside
 * each cell — cells stack vertically but each cell internally reads
 * side-by-side, which matches how nbdime renders.
 */
function diffLibraryOptions(theme: DiffsThemeNames, dark: boolean) {
  return {
    diffStyle: 'split' as const,
    disableFileHeader: true,
    theme,
    themeType: dark ? ('dark' as const) : ('light' as const)
  };
}

/**
 * Mount a Lumino {@link Widget} inside a React tree. The widget is the
 * source of truth for its DOM — React just owns the host element and
 * Lumino owns the content the widget paints into it. Detach + dispose
 * happens on unmount or when a new widget arrives, so the parent doesn't
 * need to manage the widget's lifecycle separately.
 */
function LuminoWidget(props: {
  widget: Widget;
  className?: string;
}): React.ReactElement {
  const { widget, className } = props;
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const host = ref.current;
    if (host === null || widget.isDisposed) {
      return;
    }
    try {
      Widget.attach(widget, host);
    } catch (err) {
      // Lumino refuses to attach a widget whose host isn't connected to
      // the document, or that's already attached elsewhere. Either way
      // there's nothing useful to do here — log and bail so the parent
      // tree still mounts.
      console.warn('xtralab: Widget.attach failed', err);
      return;
    }
    return () => {
      // Lumino's `Widget.detach` throws "Widget is not attached" when
      // either the `IsAttached` flag is false *or* the node is no longer
      // connected to the document. During a parent React unmount the
      // host element gets removed from the DOM before this cleanup
      // runs, so `node.isConnected` is already `false` while the
      // `IsAttached` flag is still set from our earlier `Widget.attach`
      // call. Calling `Widget.detach` in that state would throw, and —
      // worse — `widget.dispose()` re-enters the same detach branch
      // internally (its `else if (this.isAttached)` guard does not
      // check the DOM connection), so leaving the flag stale produces
      // the noisy "Widget is not attached" warning out of `dispose`.
      //
      // Resolve the race by driving Lumino's detach lifecycle by hand
      // when the host has already been torn down: send `BeforeDetach`
      // and `AfterDetach` so the layout cleanup hooks run and the flag
      // clears, then dispose. When the host is still connected the
      // ordinary `Widget.detach` path handles both steps for us.
      if (widget.isAttached) {
        if (widget.node.isConnected) {
          try {
            Widget.detach(widget);
          } catch (err) {
            console.warn('xtralab: Widget.detach failed', err);
          }
        } else {
          try {
            MessageLoop.sendMessage(widget, Widget.Msg.BeforeDetach);
            MessageLoop.sendMessage(widget, Widget.Msg.AfterDetach);
          } catch (err) {
            console.warn('xtralab: Widget detach messaging failed', err);
          }
        }
      }
      try {
        if (!widget.isDisposed) {
          widget.dispose();
        }
      } catch (err) {
        console.warn('xtralab: Widget.dispose failed', err);
      }
    };
  }, [widget]);
  return <div ref={ref} className={className} />;
}

/**
 * Render a sequence of nbformat outputs through JupyterLab's rendermime,
 * exactly the way a live notebook would. Wrapped here so the side-by-side
 * cell layout can drop a fully-rendered output column on either side
 * without re-implementing rich mime rendering.
 *
 * The output area is created `trusted` because the source git ref is on
 * the user's machine (working tree / index / HEAD). A diff viewer that
 * sandboxed its own user's outputs would just be inconvenient.
 */
function OutputsPreview(props: {
  outputs: INotebookOutput[];
  rendermime: IRenderMimeRegistry;
  className?: string;
}): React.ReactElement {
  const { outputs, rendermime, className } = props;
  const widget = React.useMemo(() => {
    const model = new OutputAreaModel({
      values: outputs as nbformat.IOutput[],
      trusted: true
    });
    return new SimplifiedOutputArea({ model, rendermime });
  }, [outputs, rendermime]);
  return <LuminoWidget widget={widget} className={className} />;
}

/**
 * Render markdown source through rendermime so the cell preview matches
 * what JupyterLab would render in a live notebook (LaTeX, syntax-highlighted
 * code fences, sanitized HTML, …). Used for both the rendered preview that
 * sits next to a markdown cell's source diff, and for unchanged markdown
 * cells when the user expands them.
 */
function MarkdownPreview(props: {
  source: string;
  rendermime: IRenderMimeRegistry;
  className?: string;
}): React.ReactElement {
  const { source, rendermime, className } = props;
  const renderer = React.useMemo(
    () => rendermime.createRenderer('text/markdown'),
    [rendermime]
  );
  React.useEffect(() => {
    const model = new MimeModel({
      data: { 'text/markdown': source },
      trusted: true
    });
    renderer.renderModel(model).catch(err => {
      console.error('xtralab: markdown render failed', err);
    });
  }, [renderer, source]);
  return <LuminoWidget widget={renderer} className={className} />;
}

/**
 * Two-column "old | new" layout used by both {@link OutputsSection} and
 * {@link MarkdownPreviewSection}. The visible side(s) depend on the cell
 * kind: modified shows both, added shows only new, removed shows only old,
 * unchanged collapses to a single full-width pane (since both sides
 * render the same content).
 */
function SideBySidePanes(props: {
  label: string;
  oldNode: React.ReactNode;
  newNode: React.ReactNode;
  hasOld: boolean;
  hasNew: boolean;
}): React.ReactElement | null {
  const { label, oldNode, newNode, hasOld, hasNew } = props;
  if (!hasOld && !hasNew) {
    return null;
  }
  const both = hasOld && hasNew;
  return (
    <div
      className={`${NOTEBOOK_DIFF_CSS_CLASS}-sideBySide`}
      data-layout={both ? 'split' : 'single'}
    >
      <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-subdiffLabel`}>{label}</div>
      <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-sideBySideGrid`}>
        {both || hasOld ? (
          <div
            className={`${NOTEBOOK_DIFF_CSS_CLASS}-sidePane`}
            data-side="old"
          >
            {oldNode}
          </div>
        ) : null}
        {both || hasNew ? (
          <div
            className={`${NOTEBOOK_DIFF_CSS_CLASS}-sidePane`}
            data-side="new"
          >
            {newNode}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Rendered outputs section for a cell. Renders old / new outputs through
 * rendermime in two columns; for added or removed cells only the populated
 * side is shown. Returns `null` (so the section is hidden entirely) when
 * neither side has any outputs, or when the same set of outputs appears
 * on both sides and the host doesn't want the duplicate render.
 */
function OutputsSection(props: {
  entry: NotebookCellDiff;
  rendermime: IRenderMimeRegistry | null;
  placement: CellPlacement;
}): React.ReactElement | null {
  const { entry, rendermime, placement } = props;
  const oldCell = 'oldCell' in entry ? entry.oldCell : null;
  const newCell = 'newCell' in entry ? entry.newCell : null;
  const oldOutputs = oldCell?.outputs ?? [];
  const newOutputs = newCell?.outputs ?? [];
  const hasOld = oldOutputs.length > 0;
  const hasNew = newOutputs.length > 0;
  if (!hasOld && !hasNew) {
    return null;
  }
  // For added / removed cells the parent already lives in a single outer
  // column — rendering the populated side full width within that column
  // is the right move. SideBySidePanes itself collapses to a single grid
  // column when only one side has content, so we can use it for both
  // cases by feeding it only the side(s) we want.
  const showOld = placement !== 'right' && hasOld;
  const showNew = placement !== 'left' && hasNew;
  if (rendermime === null) {
    return (
      <SideBySidePanes
        label="Outputs"
        hasOld={showOld}
        hasNew={showNew}
        oldNode={
          <pre className={`${NOTEBOOK_DIFF_CSS_CLASS}-fallbackText`}>
            {oldCell !== null ? canonicalOutputs(oldCell) : ''}
          </pre>
        }
        newNode={
          <pre className={`${NOTEBOOK_DIFF_CSS_CLASS}-fallbackText`}>
            {newCell !== null ? canonicalOutputs(newCell) : ''}
          </pre>
        }
      />
    );
  }
  return (
    <SideBySidePanes
      label="Outputs"
      hasOld={showOld}
      hasNew={showNew}
      oldNode={<OutputsPreview outputs={oldOutputs} rendermime={rendermime} />}
      newNode={<OutputsPreview outputs={newOutputs} rendermime={rendermime} />}
    />
  );
}

/**
 * Rendered markdown preview section. Sits next to (and below) the markdown
 * source diff so the user sees both the source-level changes and how the
 * rendered cell looks. Skipped for non-markdown cells.
 */
function MarkdownPreviewSection(props: {
  entry: NotebookCellDiff;
  rendermime: IRenderMimeRegistry | null;
  placement: CellPlacement;
}): React.ReactElement | null {
  const { entry, rendermime, placement } = props;
  const isMarkdown = referenceCellType(entry) === 'markdown';
  if (!isMarkdown || rendermime === null) {
    return null;
  }
  const oldSource = 'oldCell' in entry ? cellSource(entry.oldCell) : '';
  const newSource = 'newCell' in entry ? cellSource(entry.newCell) : '';
  const showOld = placement !== 'right' && oldSource.length > 0;
  const showNew = placement !== 'left' && newSource.length > 0;
  if (!showOld && !showNew) {
    return null;
  }
  return (
    <SideBySidePanes
      label="Rendered"
      hasOld={showOld}
      hasNew={showNew}
      oldNode={<MarkdownPreview source={oldSource} rendermime={rendermime} />}
      newNode={<MarkdownPreview source={newSource} rendermime={rendermime} />}
    />
  );
}

interface INotebookDiffViewProps {
  diff: INotebookDiffResult;
  dark: boolean;
  rendermime: IRenderMimeRegistry | null;
}

/**
 * The notebook-level diff view. Lays out cells in a 2-column grid where
 * the left column tracks the *old* notebook and the right column tracks
 * the *new* one — modified and unchanged cells span both columns (their
 * internal split-mode FileDiff aligns with the outer columns), added
 * cells live in the right column with an empty placeholder on the left,
 * and removed cells live in the left column with an empty placeholder on
 * the right. The diff library's red/green tint within each cell makes
 * the orientation clear without a separate column header.
 */
export function NotebookDiffView(
  props: INotebookDiffViewProps
): React.ReactElement {
  const { diff, dark, rendermime } = props;
  const theme: DiffsThemeNames = dark ? 'pierre-dark' : 'pierre-light';
  const summary = React.useMemo(() => summarize(diff.cells), [diff.cells]);
  return (
    <div className={NOTEBOOK_DIFF_CSS_CLASS}>
      <NotebookDiffHeader summary={summary} />
      <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-grid`}>
        {diff.cells.map(entry => (
          <CellEntryRow
            key={cellEntryKey(entry)}
            entry={entry}
            language={diff.language}
            theme={theme}
            dark={dark}
            rendermime={rendermime}
          />
        ))}
      </div>
      {diff.notebookMetadataDiff !== null ? (
        <NotebookMetadataBlock
          metadata={diff.notebookMetadataDiff}
          theme={theme}
          dark={dark}
        />
      ) : null}
    </div>
  );
}

/**
 * Place a single cell entry into the outer 2-column grid. Modified /
 * unchanged entries span the full row; added entries take the right
 * column with an empty placeholder on the left; removed entries take the
 * left column with an empty placeholder on the right. The placeholders
 * are visible (subtle dashed outline) so the user can see *where* a
 * cell was inserted or removed relative to the other side.
 */
function CellEntryRow(props: ICellDiffBlockProps): React.ReactElement {
  const { entry } = props;
  if (entry.kind === 'added') {
    return (
      <>
        <EmptyCellPlaceholder side="old" reason="added" />
        <CellDiffBlock {...props} placement="right" />
      </>
    );
  }
  if (entry.kind === 'removed') {
    return (
      <>
        <CellDiffBlock {...props} placement="left" />
        <EmptyCellPlaceholder side="new" reason="removed" />
      </>
    );
  }
  return <CellDiffBlock {...props} placement="full" />;
}

function EmptyCellPlaceholder(props: {
  side: 'old' | 'new';
  reason: 'added' | 'removed';
}): React.ReactElement {
  const { side, reason } = props;
  const label = reason === 'added' ? 'cell added on the right' : 'cell removed';
  return (
    <div
      className={`${NOTEBOOK_DIFF_CSS_CLASS}-empty`}
      data-side={side}
      aria-label={label}
    >
      <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-emptyLabel`}>
        {reason === 'added' ? '— no cell —' : '— cell removed —'}
      </span>
    </div>
  );
}

interface INotebookDiffSummary {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
}

function summarize(cells: NotebookCellDiff[]): INotebookDiffSummary {
  const summary: INotebookDiffSummary = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0
  };
  for (const entry of cells) {
    summary[entry.kind] += 1;
  }
  return summary;
}

function NotebookDiffHeader(props: {
  summary: INotebookDiffSummary;
}): React.ReactElement {
  const { summary } = props;
  const total =
    summary.added + summary.removed + summary.modified + summary.unchanged;
  return (
    <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-header`}>
      <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-headerCount`}>
        {total} cell{total === 1 ? '' : 's'}
      </span>
      {summary.modified > 0 ? (
        <span
          className={`${NOTEBOOK_DIFF_CSS_CLASS}-stat`}
          data-kind="modified"
        >
          {summary.modified} modified
        </span>
      ) : null}
      {summary.added > 0 ? (
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-stat`} data-kind="added">
          {summary.added} added
        </span>
      ) : null}
      {summary.removed > 0 ? (
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-stat`} data-kind="removed">
          {summary.removed} removed
        </span>
      ) : null}
      {summary.unchanged > 0 ? (
        <span
          className={`${NOTEBOOK_DIFF_CSS_CLASS}-stat`}
          data-kind="unchanged"
        >
          {summary.unchanged} unchanged
        </span>
      ) : null}
    </div>
  );
}

function cellEntryKey(entry: NotebookCellDiff): string {
  if (entry.kind === 'added') {
    return `added:${entry.newIndex}:${entry.newCell.id ?? ''}`;
  }
  if (entry.kind === 'removed') {
    return `removed:${entry.oldIndex}:${entry.oldCell.id ?? ''}`;
  }
  return `${entry.kind}:${entry.newIndex}:${entry.newCell.id ?? entry.oldCell.id ?? ''}`;
}

interface ICellDiffBlockProps {
  entry: NotebookCellDiff;
  language: string | undefined;
  theme: DiffsThemeNames;
  dark: boolean;
  rendermime: IRenderMimeRegistry | null;
}

/**
 * How the cell card should sit inside the outer 2-column grid:
 *   - `full`  → spans both columns (modified / unchanged cells)
 *   - `left`  → left column only (removed cells)
 *   - `right` → right column only (added cells)
 *
 * Drives both grid placement and the inner layout choices: a single-column
 * placement uses unified-mode FileDiff for the source (since one side is
 * empty) and renders only the populated side of outputs / markdown
 * previews, while a `full` placement keeps split mode and side-by-side
 * panes.
 */
type CellPlacement = 'full' | 'left' | 'right';

interface IPlacedCellDiffBlockProps extends ICellDiffBlockProps {
  placement: CellPlacement;
}

function CellDiffBlock(props: IPlacedCellDiffBlockProps): React.ReactElement {
  const { entry, language, theme, dark, rendermime, placement } = props;
  // Unchanged cells start collapsed — the user opted out of seeing those
  // sections by virtue of them being unchanged. A toggle lets them peek if
  // they want.
  const [collapsed, setCollapsed] = React.useState<boolean>(
    entry.kind === 'unchanged'
  );

  const subdiffs = React.useMemo(
    () => (collapsed ? [] : buildCellSubDiffs(entry, language)),
    [collapsed, entry, language]
  );

  const cellType = referenceCellType(entry);
  const indexLabel = cellIndexLabel(entry);
  const isCodeCell = cellType === 'code';
  // Output rendering is only meaningful for code cells. Markdown / raw cells
  // never carry outputs in nbformat.
  const showOutputs = isCodeCell && entry.kind !== 'unchanged';

  return (
    <section
      className={`${NOTEBOOK_DIFF_CSS_CLASS}-cell`}
      data-kind={entry.kind}
      data-cell-type={cellType}
      data-placement={placement}
    >
      <header
        className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellHeader`}
        onClick={() => setCollapsed(c => !c)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setCollapsed(c => !c);
          }
        }}
      >
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellChevron`}>
          {collapsed ? '▸' : '▾'}
        </span>
        <span
          className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellBadge`}
          data-kind={entry.kind}
        >
          {kindBadge(entry.kind)}
        </span>
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellLabel`}>
          {indexLabel} · {cellType}
        </span>
        {entry.kind === 'unchanged' ? (
          <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellHint`}>
            unchanged
          </span>
        ) : null}
      </header>
      {!collapsed ? (
        <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellBody`}>
          {entry.kind === 'unchanged' ? (
            <UnchangedCellBody entry={entry} rendermime={rendermime} />
          ) : (
            <>
              {subdiffs.map(sub => (
                <CellSubDiff
                  key={sub.kind}
                  kind={sub.kind}
                  metadata={sub.metadata}
                  theme={theme}
                  dark={dark}
                  placement={placement}
                />
              ))}
              <MarkdownPreviewSection
                entry={entry}
                rendermime={rendermime}
                placement={placement}
              />
              {showOutputs ? (
                <OutputsSection
                  entry={entry}
                  rendermime={rendermime}
                  placement={placement}
                />
              ) : null}
              {subdiffs.length === 0 &&
              !(
                showOutputs &&
                (('oldCell' in entry && entry.oldCell.outputs?.length) ||
                  ('newCell' in entry && entry.newCell.outputs?.length))
              ) ? (
                <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellEmpty`}>
                  No content differences detected.
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function CellSubDiff(props: {
  kind: 'source' | 'metadata';
  metadata: FileDiffMetadata;
  theme: DiffsThemeNames;
  dark: boolean;
  placement: CellPlacement;
}): React.ReactElement {
  const { kind, metadata, theme, dark, placement } = props;
  // For modified / unchanged cells the diff spans both outer columns, and
  // split mode lets it visually align with the outer old | new lanes. For
  // added / removed cells the diff sits inside a single outer column, so
  // unified mode keeps the content readable instead of leaving half the
  // column empty.
  const diffStyle: 'split' | 'unified' =
    placement === 'full' ? 'split' : 'unified';
  return (
    <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-subdiff`} data-section={kind}>
      <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-subdiffLabel`}>
        {subdiffLabel(kind)}
      </div>
      <FileDiff
        fileDiff={metadata}
        // See diffWidget.tsx — the worker bootstrap can't resolve through
        // JupyterLab's federation pipeline, so every diff in this extension
        // runs on the main thread. Cell diffs are small enough that this is
        // not a performance concern.
        disableWorkerPool={true}
        options={{ ...diffLibraryOptions(theme, dark), diffStyle }}
      />
    </div>
  );
}

function NotebookMetadataBlock(props: {
  metadata: FileDiffMetadata;
  theme: DiffsThemeNames;
  dark: boolean;
}): React.ReactElement {
  const { metadata, theme, dark } = props;
  return (
    <section
      className={`${NOTEBOOK_DIFF_CSS_CLASS}-cell`}
      data-kind="modified"
      data-cell-type="metadata"
    >
      <header
        className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellHeader`}
        aria-label="Notebook metadata"
      >
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellChevron`}>▾</span>
        <span
          className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellBadge`}
          data-kind="modified"
        >
          M
        </span>
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellLabel`}>
          Notebook metadata
        </span>
      </header>
      <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellBody`}>
        <CellSubDiff
          kind="metadata"
          metadata={metadata}
          theme={theme}
          dark={dark}
          placement="full"
        />
      </div>
    </section>
  );
}

/**
 * Body for an unchanged cell when the user has expanded it. The cell's
 * content matches on both sides, so we render once full-width: markdown
 * cells go through rendermime (if available) so they look like the live
 * notebook would render them, code cells fall through to a verbatim
 * pre-formatted block, and any code outputs render through rendermime
 * below the source.
 */
function UnchangedCellBody(props: {
  entry: Extract<NotebookCellDiff, { kind: 'unchanged' }>;
  rendermime: IRenderMimeRegistry | null;
}): React.ReactElement {
  const { entry, rendermime } = props;
  const cell = entry.newCell;
  const source = cellSource(cell);
  const isMarkdown = cell.cell_type === 'markdown';
  const outputs = cell.outputs ?? [];
  const hasOutputs = outputs.length > 0;
  return (
    <>
      {isMarkdown && rendermime !== null && source.length > 0 ? (
        <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-unchangedRendered`}>
          <MarkdownPreview source={source} rendermime={rendermime} />
        </div>
      ) : (
        <pre className={`${NOTEBOOK_DIFF_CSS_CLASS}-unchangedSource`}>
          {source.length > 0 ? source : '(empty cell)'}
        </pre>
      )}
      {hasOutputs && rendermime !== null ? (
        <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-unchangedOutputs`}>
          <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-subdiffLabel`}>
            Outputs
          </div>
          <OutputsPreview outputs={outputs} rendermime={rendermime} />
        </div>
      ) : null}
    </>
  );
}

function referenceCellType(entry: NotebookCellDiff): string {
  if (entry.kind === 'added') {
    return entry.newCell.cell_type;
  }
  if (entry.kind === 'removed') {
    return entry.oldCell.cell_type;
  }
  return entry.newCell.cell_type;
}

function cellIndexLabel(entry: NotebookCellDiff): string {
  if (entry.kind === 'added') {
    return `Cell ${entry.newIndex + 1}`;
  }
  if (entry.kind === 'removed') {
    return `Cell ${entry.oldIndex + 1} (removed)`;
  }
  if (entry.newIndex === entry.oldIndex) {
    return `Cell ${entry.newIndex + 1}`;
  }
  return `Cell ${entry.oldIndex + 1} → ${entry.newIndex + 1}`;
}

function kindBadge(kind: NotebookCellDiff['kind']): string {
  switch (kind) {
    case 'added':
      return 'A';
    case 'removed':
      return 'D';
    case 'modified':
      return 'M';
    case 'unchanged':
      return '·';
  }
}

function subdiffLabel(kind: 'source' | 'metadata'): string {
  switch (kind) {
    case 'source':
      return 'Source';
    case 'metadata':
      return 'Metadata';
  }
}
