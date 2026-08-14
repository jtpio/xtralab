import * as React from 'react';

import type * as nbformat from '@jupyterlab/nbformat';
import { OutputAreaModel, SimplifiedOutputArea } from '@jupyterlab/outputarea';
import { IRenderMimeRegistry, MimeModel } from '@jupyterlab/rendermime';
import type { TranslationBundle } from '@jupyterlab/translation';
import { MessageLoop } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import { FileDiff } from '@pierre/diffs/react';
import {
  parseDiffFromFile,
  type DiffsThemeNames,
  type FileContents,
  type FileDiffMetadata
} from '@pierre/diffs';

import { resolveDiffTheme } from './diffTheme';

const NOTEBOOK_DIFF_CSS_CLASS = 'jp-xtralab-NotebookDiff';

/**
 * Minimal slice of nbformat 4.x that the diff inspects.
 */
interface INotebookCell {
  cell_type: string;
  id?: string;
  source: string | string[];
  outputs?: INotebookOutput[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  attachments?: Record<string, unknown>;
}

interface INotebookOutput {
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

interface INotebook {
  cells: INotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

/**
 * One entry in the per-cell diff. `modified` and `unchanged` carry the same
 * payload on separate union members so `Extract` narrowing on `kind` works.
 */
type NotebookCellDiff =
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
 * Notebook-level diff result returned by {@link buildNotebookDiff}.
 */
export interface INotebookDiffResult {
  oldNotebook: INotebook;
  newNotebook: INotebook;
  cells: NotebookCellDiff[];
  language: string | undefined;
  notebookMetadataDiff: FileDiffMetadata | null;
}

/**
 * Parse notebook JSON. Returns `null` when the text is not a notebook so
 * the caller can fall back to a raw text diff.
 */
function parseNotebook(text: string): INotebook | null {
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

function joinMultiline(value: string | string[] | undefined): string {
  if (value === undefined) {
    return '';
  }
  return Array.isArray(value) ? value.join('') : value;
}

function cellSource(cell: INotebookCell): string {
  return joinMultiline(cell.source);
}

/**
 * Canonical text form of a cell's outputs, used for equality checks and
 * diffs. Rich mime types collapse to a `<mime-type>` placeholder so base64
 * payloads don't drown the diff.
 */
function canonicalOutputs(cell: INotebookCell): string {
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
      const traceback = (output.traceback ?? []).map(stripAnsi).join('\n');
      return `[error]\n${ename}: ${evalue}\n${traceback}`;
    }
    default:
      return `[${output.output_type}]`;
  }
}

// Matching ANSI escapes requires a control character in the pattern.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, '');
}

/**
 * Stable sorted JSON of the cell's `metadata`; empty metadata returns ''
 * so cells carrying the default `{}` don't produce a `+{}` diff section.
 */
function canonicalMetadata(cell: INotebookCell): string {
  const md = cell.metadata ?? {};
  if (Object.keys(md).length === 0) {
    return '';
  }
  return stableStringify(md);
}

function canonicalNotebookMetadata(notebook: INotebook): string {
  return stableStringify({
    metadata: notebook.metadata,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortKeysReplacer, 2);
}

function sortKeysReplacer(key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const name of Object.keys(value).sort()) {
      sorted[name] = (value as Record<string, unknown>)[name];
    }
    return sorted;
  }
  return value;
}

/**
 * Classify matched cells as `unchanged` vs `modified` using the same
 * canonical forms the diff renders, so "equal" implies empty per-cell diffs.
 */
function cellsAreEqual(a: INotebookCell, b: INotebookCell): boolean {
  return (
    a.cell_type === b.cell_type &&
    cellSource(a) === cellSource(b) &&
    canonicalOutputs(a) === canonicalOutputs(b) &&
    canonicalMetadata(a) === canonicalMetadata(b)
  );
}

/**
 * Align cells between two revisions: stable ids (nbformat ≥ 4.5) match by
 * id, the rest positionally. Entries follow new-file order with old-only
 * cells appended as `removed`.
 */
function alignNotebookCells(
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

interface IBuildNotebookDiffOptions {
  oldText: string;
  newText: string;
}

/**
 * Build a notebook diff from the text of two revisions. Returns `null` when
 * either side fails to parse (caller falls back to a raw text diff); an
 * empty string counts as an empty notebook so added/deleted notebooks still
 * diff cell by cell.
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
 * Pick a filename whose extension drives the `@pierre/diffs` highlighter;
 * the library never reads the file, only the extension matters.
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
    // Fall back to the old side so a deleted cell still gets the right highlighter.
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
 * Source / metadata sub-diffs for one cell entry; empty for `unchanged`.
 * Outputs are excluded on purpose — they render through rendermime in
 * {@link OutputsSection}; their canonical text form only drives equality.
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

function diffLibraryOptions(theme: DiffsThemeNames, dark: boolean) {
  return {
    diffStyle: 'split' as const,
    disableFileHeader: true,
    theme,
    themeType: dark ? ('dark' as const) : ('light' as const)
  };
}

/**
 * Mount a Lumino {@link Widget} inside a React tree; detach + dispose
 * happens on unmount or when a new widget arrives.
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
      // Lumino refuses to attach when the host is not in the document or
      // the widget is attached elsewhere; log and let the tree mount.
      console.warn('xtralab: Widget.attach failed', err);
      return;
    }
    return () => {
      // On parent unmount React removes the host first; detach (and dispose,
      // which re-enters it) throws on a disconnected node, so message by hand.
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
 * Render nbformat outputs through rendermime like a live notebook would.
 * Trusted: the source git ref already lives on the user's machine.
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
 * Render markdown source through rendermime so the preview matches a live
 * notebook (LaTeX, code fences, sanitized HTML).
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
 * Two-column "old | new" layout; collapses to a single full-width pane
 * when only one side has content.
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
 * Rendered outputs for a cell, old / new through rendermime; `null` when
 * neither side has outputs.
 */
function OutputsSection(props: {
  entry: NotebookCellDiff;
  rendermime: IRenderMimeRegistry | null;
  placement: CellPlacement;
  trans: TranslationBundle;
}): React.ReactElement | null {
  const { entry, rendermime, placement, trans } = props;
  const oldCell = 'oldCell' in entry ? entry.oldCell : null;
  const newCell = 'newCell' in entry ? entry.newCell : null;
  const oldOutputs = oldCell?.outputs ?? [];
  const newOutputs = newCell?.outputs ?? [];
  const hasOld = oldOutputs.length > 0;
  const hasNew = newOutputs.length > 0;
  if (!hasOld && !hasNew) {
    return null;
  }
  const showOld = placement !== 'right' && hasOld;
  const showNew = placement !== 'left' && hasNew;
  if (rendermime === null) {
    return (
      <SideBySidePanes
        label={trans.__('Outputs')}
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
      label={trans.__('Outputs')}
      hasOld={showOld}
      hasNew={showNew}
      oldNode={<OutputsPreview outputs={oldOutputs} rendermime={rendermime} />}
      newNode={<OutputsPreview outputs={newOutputs} rendermime={rendermime} />}
    />
  );
}

/**
 * Rendered markdown preview beside the source diff; skipped for non-markdown cells.
 */
function MarkdownPreviewSection(props: {
  entry: NotebookCellDiff;
  rendermime: IRenderMimeRegistry | null;
  placement: CellPlacement;
  trans: TranslationBundle;
}): React.ReactElement | null {
  const { entry, rendermime, placement, trans } = props;
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
      label={trans.__('Rendered')}
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
  pierreTheme: boolean;
  rendermime: IRenderMimeRegistry | null;
  trans: TranslationBundle;
}

/**
 * Notebook-level diff view: a 2-column grid where the left column tracks
 * the old notebook and the right the new one — modified/unchanged cells
 * span both, added cells sit right, removed cells sit left.
 */
export function NotebookDiffView(
  props: INotebookDiffViewProps
): React.ReactElement {
  const { diff, dark, pierreTheme, rendermime, trans } = props;
  const theme: DiffsThemeNames = resolveDiffTheme(dark, pierreTheme);
  const summary = React.useMemo(() => summarize(diff.cells), [diff.cells]);
  return (
    <div className={NOTEBOOK_DIFF_CSS_CLASS}>
      <NotebookDiffHeader summary={summary} trans={trans} />
      <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-grid`}>
        {diff.cells.map(entry => (
          <CellEntryRow
            key={cellEntryKey(entry)}
            entry={entry}
            language={diff.language}
            theme={theme}
            dark={dark}
            rendermime={rendermime}
            trans={trans}
          />
        ))}
      </div>
      {diff.notebookMetadataDiff !== null ? (
        <NotebookMetadataBlock
          metadata={diff.notebookMetadataDiff}
          theme={theme}
          dark={dark}
          trans={trans}
        />
      ) : null}
    </div>
  );
}

/**
 * Place one cell entry into the 2-column grid, with a visible placeholder
 * marking where a cell was inserted or removed on the other side.
 */
function CellEntryRow(props: ICellDiffBlockProps): React.ReactElement {
  const { entry, trans } = props;
  if (entry.kind === 'added') {
    return (
      <>
        <EmptyCellPlaceholder side="old" reason="added" trans={trans} />
        <CellDiffBlock {...props} placement="right" />
      </>
    );
  }
  if (entry.kind === 'removed') {
    return (
      <>
        <CellDiffBlock {...props} placement="left" />
        <EmptyCellPlaceholder side="new" reason="removed" trans={trans} />
      </>
    );
  }
  return <CellDiffBlock {...props} placement="full" />;
}

function EmptyCellPlaceholder(props: {
  side: 'old' | 'new';
  reason: 'added' | 'removed';
  trans: TranslationBundle;
}): React.ReactElement {
  const { side, reason, trans } = props;
  const label =
    reason === 'added'
      ? trans.__('cell added on the right')
      : trans.__('cell removed');
  return (
    <div
      className={`${NOTEBOOK_DIFF_CSS_CLASS}-empty`}
      data-side={side}
      aria-label={label}
    >
      <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-emptyLabel`}>
        {reason === 'added'
          ? trans.__('— no cell —')
          : trans.__('— cell removed —')}
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
  trans: TranslationBundle;
}): React.ReactElement {
  const { summary, trans } = props;
  const total =
    summary.added + summary.removed + summary.modified + summary.unchanged;
  return (
    <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-header`}>
      <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-headerCount`}>
        {trans._n('%1 cell', '%1 cells', total)}
      </span>
      {summary.modified > 0 ? (
        <span
          className={`${NOTEBOOK_DIFF_CSS_CLASS}-stat`}
          data-kind="modified"
        >
          {trans.__('%1 modified', summary.modified)}
        </span>
      ) : null}
      {summary.added > 0 ? (
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-stat`} data-kind="added">
          {trans.__('%1 added', summary.added)}
        </span>
      ) : null}
      {summary.removed > 0 ? (
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-stat`} data-kind="removed">
          {trans.__('%1 removed', summary.removed)}
        </span>
      ) : null}
      {summary.unchanged > 0 ? (
        <span
          className={`${NOTEBOOK_DIFF_CSS_CLASS}-stat`}
          data-kind="unchanged"
        >
          {trans.__('%1 unchanged', summary.unchanged)}
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
  trans: TranslationBundle;
}

type CellPlacement = 'full' | 'left' | 'right';

interface IPlacedCellDiffBlockProps extends ICellDiffBlockProps {
  placement: CellPlacement;
}

function CellDiffBlock(props: IPlacedCellDiffBlockProps): React.ReactElement {
  const { entry, language, theme, dark, rendermime, placement, trans } = props;
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
  // Only code cells carry outputs in nbformat.
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
          {kindBadge(entry.kind, trans)}
        </span>
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellLabel`}>
          {indexLabel} · {cellType}
        </span>
        {entry.kind === 'unchanged' ? (
          <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellHint`}>
            {trans.__('unchanged')}
          </span>
        ) : null}
      </header>
      {!collapsed ? (
        <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellBody`}>
          {entry.kind === 'unchanged' ? (
            <UnchangedCellBody
              entry={entry}
              rendermime={rendermime}
              trans={trans}
            />
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
                  trans={trans}
                />
              ))}
              <MarkdownPreviewSection
                entry={entry}
                rendermime={rendermime}
                placement={placement}
                trans={trans}
              />
              {showOutputs ? (
                <OutputsSection
                  entry={entry}
                  rendermime={rendermime}
                  placement={placement}
                  trans={trans}
                />
              ) : null}
              {subdiffs.length === 0 &&
              !(
                showOutputs &&
                (('oldCell' in entry && entry.oldCell.outputs?.length) ||
                  ('newCell' in entry && entry.newCell.outputs?.length))
              ) ? (
                <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellEmpty`}>
                  {trans.__('No content differences detected.')}
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
  trans: TranslationBundle;
}): React.ReactElement {
  const { kind, metadata, theme, dark, placement, trans } = props;
  // Full-width cells align split mode with the outer old|new lanes;
  // single-column cells read better unified.
  const diffStyle: 'split' | 'unified' =
    placement === 'full' ? 'split' : 'unified';
  return (
    <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-subdiff`} data-section={kind}>
      <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-subdiffLabel`}>
        {subdiffLabel(kind, trans)}
      </div>
      <FileDiff
        fileDiff={metadata}
        // The worker bootstrap can't resolve through JupyterLab's federation
        // pipeline (see diffSurface.tsx); run on the main thread.
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
  trans: TranslationBundle;
}): React.ReactElement {
  const { metadata, theme, dark, trans } = props;
  return (
    <section
      className={`${NOTEBOOK_DIFF_CSS_CLASS}-cell`}
      data-kind="modified"
      data-cell-type="metadata"
    >
      <header
        className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellHeader`}
        aria-label={trans.__('Notebook metadata')}
      >
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellChevron`}>▾</span>
        <span
          className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellBadge`}
          data-kind="modified"
        >
          {trans.__('M')}
        </span>
        <span className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellLabel`}>
          {trans.__('Notebook metadata')}
        </span>
      </header>
      <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-cellBody`}>
        <CellSubDiff
          kind="metadata"
          metadata={metadata}
          theme={theme}
          dark={dark}
          placement="full"
          trans={trans}
        />
      </div>
    </section>
  );
}

/**
 * Expanded body of an unchanged cell, rendered once full-width: markdown
 * through rendermime, code verbatim with outputs below.
 */
function UnchangedCellBody(props: {
  entry: Extract<NotebookCellDiff, { kind: 'unchanged' }>;
  rendermime: IRenderMimeRegistry | null;
  trans: TranslationBundle;
}): React.ReactElement {
  const { entry, rendermime, trans } = props;
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
          {source.length > 0 ? source : trans.__('(empty cell)')}
        </pre>
      )}
      {hasOutputs && rendermime !== null ? (
        <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-unchangedOutputs`}>
          <div className={`${NOTEBOOK_DIFF_CSS_CLASS}-subdiffLabel`}>
            {trans.__('Outputs')}
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

function kindBadge(
  kind: NotebookCellDiff['kind'],
  trans: TranslationBundle
): string {
  switch (kind) {
    case 'added':
      return trans.__('A');
    case 'removed':
      return trans.__('D');
    case 'modified':
      return trans.__('M');
    case 'unchanged':
      return '·';
  }
}

function subdiffLabel(
  kind: 'source' | 'metadata',
  trans: TranslationBundle
): string {
  switch (kind) {
    case 'source':
      return trans.__('Source');
    case 'metadata':
      return trans.__('Metadata');
  }
}
