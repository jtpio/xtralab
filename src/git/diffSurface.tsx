import * as React from 'react';

import { IThemeManager } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { undoIcon } from '@jupyterlab/ui-components';
import { FileDiff } from '@pierre/diffs/react';
import {
  diffAcceptRejectHunk,
  parseDiffFromFile,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata
} from '@pierre/diffs';

import { ImageDiffView, imageDataType } from './imageDiff';
import {
  buildNotebookDiff,
  NotebookDiffView,
  type INotebookDiffResult
} from './notebookDiff';
import { resolveDiffTheme } from './diffTheme';

/**
 * The CSS class added to the diff main-area widget. The selectors that
 * style the embedded `@pierre/diffs` viewer hang off this class.
 */
export const DIFF_WIDGET_CSS_CLASS = 'jp-xtralab-DiffWidget';

/**
 * `localStorage` key for the user's last-chosen split ratio, persisted so
 * the preference survives reloads (the library has no built-in way to
 * remember it).
 */
const SPLIT_RATIO_STORAGE_KEY = 'xtralab:diff-split-ratio';

/**
 * Bounds on the left-pane fraction. Keeping a few percent on either side
 * guarantees both panes remain visible — dragging to 0/100 would hide a
 * column and is almost never what the user wants.
 */
const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;
const DEFAULT_SPLIT_RATIO = 0.5;

/**
 * CSS injected via the `@pierre/diffs` `unsafeCSS` option. The library
 * places it inside the shadow root under `@layer unsafe`, which beats
 * the library's own `@layer base` rule that hardcodes
 * `grid-template-columns: 1fr 1fr` on the split-mode container.
 *
 * The override reads from `--xtralab-split-cols`, a custom property we set
 * on the host element via the `style` prop. Custom properties inherit
 * through the shadow DOM boundary, so adjusting it on the host instantly
 * resizes the columns without re-rendering the diff.
 */
const SPLIT_RESIZE_CSS = `pre[data-diff-type="split"][data-overflow="scroll"] {
  grid-template-columns: var(--xtralab-split-cols, 1fr 1fr);
}`;

function readStoredSplitRatio(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_SPLIT_RATIO;
    }
    const parsed = Number.parseFloat(raw);
    if (
      Number.isFinite(parsed) &&
      parsed >= MIN_SPLIT_RATIO &&
      parsed <= MAX_SPLIT_RATIO
    ) {
      return parsed;
    }
  } catch {
    // localStorage may throw in privacy mode or sandboxed contexts. Falling
    // back to the default is fine — the user can resize again on this run.
  }
  return DEFAULT_SPLIT_RATIO;
}

function writeStoredSplitRatio(ratio: number): void {
  try {
    window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, ratio.toString());
  } catch {
    // See readStoredSplitRatio — best-effort persistence.
  }
}

/**
 * Layout for textual/code diffs, forwarded to `@pierre/diffs` as its
 * `diffStyle` option. `split` is the side-by-side old|new view; `unified`
 * is the single-column inline view (what diffs.com calls "stacked").
 */
export type DiffStyle = 'split' | 'unified';

const DIFF_STYLE_STORAGE_KEY = 'xtralab:diff-style';

export function readStoredDiffStyle(): DiffStyle {
  try {
    const raw = window.localStorage.getItem(DIFF_STYLE_STORAGE_KEY);
    if (raw === 'split' || raw === 'unified') {
      return raw;
    }
  } catch {
    // See readStoredSplitRatio — privacy-mode / sandboxed contexts can throw.
  }
  return 'split';
}

export function writeStoredDiffStyle(style: DiffStyle): void {
  try {
    window.localStorage.setItem(DIFF_STYLE_STORAGE_KEY, style);
  } catch {
    // Best-effort.
  }
}

/**
 * View modes available for `.ipynb` diffs. `notebook` is the cell-by-cell
 * rendered view; `json` is the raw nbformat JSON file diff, for inspecting
 * exactly which bytes changed.
 */
export type NotebookDiffViewMode = 'notebook' | 'json';

const NOTEBOOK_DIFF_VIEW_MODE_STORAGE_KEY = 'xtralab:notebook-diff-view-mode';

export function readStoredNotebookViewMode(): NotebookDiffViewMode {
  try {
    const raw = window.localStorage.getItem(
      NOTEBOOK_DIFF_VIEW_MODE_STORAGE_KEY
    );
    if (raw === 'json' || raw === 'notebook') {
      return raw;
    }
  } catch {
    // See readStoredSplitRatio — privacy-mode / sandboxed contexts can
    // throw on access. The notebook view is the better default anyway.
  }
  return 'notebook';
}

export function writeStoredNotebookViewMode(mode: NotebookDiffViewMode): void {
  try {
    window.localStorage.setItem(NOTEBOOK_DIFF_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Best-effort.
  }
}

/**
 * Annotation payload threaded through the diff library back into the
 * `renderAnnotation` callback. Carries the index of the hunk a particular
 * action button targets.
 */
interface IHunkActionAnnotation {
  hunkIndex: number;
}

/**
 * Detect notebook files by extension. We only look at the suffix so the
 * caller doesn't need to plumb a content-type field through; mistaking
 * another `.ipynb`-named file for a notebook is harmless because
 * {@link buildNotebookDiff} validates the JSON shape and we fall back to
 * the file diff if parsing fails.
 */
function isNotebookPath(path: string): boolean {
  return path.toLowerCase().endsWith('.ipynb');
}

/**
 * Decide whether the active JupyterLab theme is a dark theme. Prefers the
 * `IThemeManager` token when available, and falls back to sniffing the
 * `data-jp-theme-light` attribute that JupyterLab sets on `<body>` so the
 * component still works in stripped-down hosts where the token isn't
 * provided (lite, certain notebook configurations, …).
 */
export function isDarkTheme(themeManager: IThemeManager | null): boolean {
  if (themeManager !== null && themeManager.theme !== null) {
    return !themeManager.isLight(themeManager.theme);
  }
  return document.body.dataset.jpThemeLight === 'false';
}

/**
 * Whether the active JupyterLab theme should keep Pierre diff highlighting.
 */
export function isPierreTheme(themeManager: IThemeManager | null): boolean {
  const theme = themeManager?.theme ?? null;
  return theme !== null && theme.toLowerCase().includes('pierre');
}

/**
 * Optional per-hunk discard wiring. When supplied and `enabled`, each hunk
 * in a plain-text/code diff gets an inline "discard" button; clicking it
 * reverts that hunk and hands the rebuilt full-file text back to the host
 * via {@link IHunkDiscard.save}. The host owns the actual write (it knows
 * the on-disk path) and triggers any follow-up refresh in
 * {@link IHunkDiscard.onAfterSave}.
 */
export interface IHunkDiscard {
  enabled: boolean;
  save: (fullText: string) => Promise<void>;
  onAfterSave: () => void;
}

export interface IDiffSurfaceProps {
  /**
   * Whether the host is still resolving the file contents.
   */
  loading: boolean;
  /**
   * Fatal error message to show instead of a diff, or `null`.
   */
  error: string | null;
  /**
   * Whether the file is binary (no textual diff is rendered).
   */
  isBinary: boolean;
  /**
   * Resolved old/reference text. Ignored while loading/binary/errored.
   */
  oldText: string;
  /**
   * Resolved new/challenger text. Ignored while loading/binary/errored.
   */
  newText: string;
  /**
   * New-side path. Drives notebook detection and the `@pierre/diffs` file
   * name on the additions side.
   */
  newName: string;
  /**
   * Old-side path. Differs from {@link newName} only for renames; defaults
   * to {@link newName} when the host does not track a previous path.
   */
  oldName?: string;
  /**
   * Whether to render with the dark `@pierre/diffs` theme.
   */
  dark: boolean;
  /**
   * Whether the diff should keep Pierre's own syntax palette.
   */
  pierreTheme: boolean;
  /**
   * Rendermime registry used by the notebook view to render outputs and
   * markdown cells. May be `null` in stripped-down hosts; the notebook
   * diff falls back to a textual representation in that case.
   */
  rendermime: IRenderMimeRegistry | null;
  /**
   * Current rendered-vs-JSON choice for notebook diffs (host-controlled).
   */
  notebookViewMode: NotebookDiffViewMode;
  /**
   * Split vs unified layout for the textual/code file diff (host-controlled).
   */
  diffStyle: DiffStyle;
  /**
   * Called whenever the availability of a rendered notebook view changes,
   * so the host can show/hide its Notebook/JSON toolbar toggle.
   */
  onNotebookAvailabilityChange?: (available: boolean) => void;
  /**
   * Called whenever the textual/code file diff (the only view the split vs
   * unified choice affects) becomes the active view, so the host can
   * show/hide its Split/Unified toolbar toggle. False for image, binary,
   * rendered-notebook, loading and error states.
   */
  onFileDiffActiveChange?: (active: boolean) => void;
  /**
   * Called after each (re)computation of the diff with the number of hunks
   * (or `null` when no textual diff exists). Hosts use this to implement
   * post-discard behaviors such as auto-closing an emptied diff.
   */
  onMetadataChange?: (info: { hunkCount: number | null }) => void;
  /**
   * Optional per-hunk discard wiring; omit for a read-only diff.
   */
  hunkDiscard?: IHunkDiscard;
}

/**
 * Shared renderer for text, notebook and image diffs.
 */
export function DiffSurface(props: IDiffSurfaceProps): React.ReactElement {
  const {
    loading,
    error,
    isBinary,
    oldText,
    newText,
    newName,
    oldName,
    dark,
    pierreTheme,
    rendermime,
    notebookViewMode,
    diffStyle,
    onNotebookAvailabilityChange,
    onFileDiffActiveChange,
    onMetadataChange,
    hunkDiscard
  } = props;

  const hasContent = !loading && error === null && !isBinary;

  // Raster images take a dedicated `<img>`-based view instead of a
  // text/notebook diff; the host passes the two sides as base64 strings in
  // `oldText`/`newText` (the git server base64-encodes binary content).
  const imageType = React.useMemo(() => imageDataType(newName), [newName]);

  // Pre-compute the line-oriented diff metadata. Owning it here lets us
  // pass it to {@link FileDiff} *and* thread the same instance through
  // {@link diffAcceptRejectHunk} when the user discards a hunk — so hunk
  // indexes line up between what the user clicked and what we mutate.
  const metadata = React.useMemo<FileDiffMetadata | null>(() => {
    if (!hasContent || imageType !== null) {
      return null;
    }
    const oldFile: FileContents = {
      name: oldName ?? newName,
      contents: oldText
    };
    const newFile: FileContents = { name: newName, contents: newText };
    return parseDiffFromFile(oldFile, newFile);
  }, [hasContent, imageType, oldText, newText, oldName, newName]);

  // Cell-by-cell notebook diff for `.ipynb` files. When non-null the
  // renderer uses a notebook-aware view instead of the line-oriented file
  // diff — kept distinct from {@link metadata} so a notebook whose JSON we
  // cannot parse can fall back to the file diff path.
  const notebookDiff = React.useMemo<INotebookDiffResult | null>(() => {
    if (!hasContent || imageType !== null || !isNotebookPath(newName)) {
      return null;
    }
    return buildNotebookDiff({ oldText, newText });
  }, [hasContent, imageType, oldText, newText, newName]);

  // Tell the host whether a rendered notebook view is currently available
  // so it can show/hide its Notebook/JSON toggle.
  React.useEffect(() => {
    onNotebookAvailabilityChange?.(notebookDiff !== null);
  }, [onNotebookAvailabilityChange, notebookDiff]);

  // Report the diff shape so hosts can react (e.g. auto-close on empty).
  React.useEffect(() => {
    onMetadataChange?.({
      hunkCount: metadata !== null ? metadata.hunks.length : null
    });
  }, [onMetadataChange, metadata]);

  // Decide which view to render. The notebook view requires a successful
  // nbformat parse; if that failed, we only show the raw JSON file diff.
  // Computed before the early returns below so the file-diff-active effect
  // can depend on it without violating the rules of hooks.
  const hasNotebookView = notebookDiff !== null;
  const showNotebookView = hasNotebookView && notebookViewMode === 'notebook';
  const showFileDiff = !showNotebookView && metadata !== null;

  // The split vs unified choice only affects the textual/code file diff, so
  // tell the host whether that view is active to drive its Split/Unified
  // toolbar toggle.
  React.useEffect(() => {
    onFileDiffActiveChange?.(showFileDiff);
  }, [onFileDiffActiveChange, showFileDiff]);

  // Split ratio for the diff columns: fraction of width given to the
  // deletions (left) pane. Persisted across sessions so the user only
  // dials in their layout once.
  const [leftRatio, setLeftRatio] = React.useState<number>(() =>
    readStoredSplitRatio()
  );
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  // The drag handler reads the live ratio from a ref so the listeners we
  // attach on pointer-down don't capture a stale value across renders.
  const leftRatioRef = React.useRef(leftRatio);
  React.useEffect(() => {
    leftRatioRef.current = leftRatio;
  }, [leftRatio]);

  const canDiscardHunk = hunkDiscard?.enabled === true;

  const lineAnnotations = React.useMemo<
    DiffLineAnnotation<IHunkActionAnnotation>[]
  >(() => {
    if (!canDiscardHunk || metadata === null) {
      return [];
    }
    return metadata.hunks.map((hunk, hunkIndex) => ({
      side: 'additions',
      // The first line of each hunk in the new file. We anchor the button
      // there so it sits at the top of the hunk's body.
      lineNumber: hunk.additionStart,
      metadata: { hunkIndex }
    }));
  }, [canDiscardHunk, metadata]);

  const handleDiscardHunk = React.useCallback(
    async (hunkIndex: number) => {
      if (metadata === null || hunkDiscard === undefined) {
        return;
      }
      const updated = diffAcceptRejectHunk(metadata, hunkIndex, 'reject');
      // `additionLines` after a 'reject' contains the full new file with
      // the hunk reverted back to the old content. The library splits
      // file contents with `/(?<=\n)/` (a lookbehind that keeps the
      // trailing `\n` on each line), so the entries already carry their
      // own line endings — joining with `''` rebuilds the original text
      // verbatim, while joining with `'\n'` would double every newline.
      const text = updated.additionLines.join('');
      try {
        await hunkDiscard.save(text);
        hunkDiscard.onAfterSave();
      } catch (err) {
        console.error('xtralab: failed to discard hunk', err);
      }
    },
    [hunkDiscard, metadata]
  );

  const renderAnnotation = React.useCallback(
    (
      annotation: DiffLineAnnotation<IHunkActionAnnotation>
    ): React.ReactNode => {
      if (annotation.metadata === undefined) {
        return null;
      }
      const { hunkIndex } = annotation.metadata;
      return (
        <div className="jp-xtralab-DiffWidget-hunkAnnotation">
          <button
            type="button"
            className="jp-xtralab-DiffWidget-hunkButton"
            title="Discard this hunk's changes"
            aria-label="Discard hunk"
            onClick={() => void handleDiscardHunk(hunkIndex)}
          >
            <undoIcon.react
              tag="span"
              className="jp-xtralab-DiffWidget-hunkButton-icon"
              elementSize="normal"
            />
          </button>
        </div>
      );
    },
    [handleDiscardHunk]
  );

  const handleResizerPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Only react to primary-button drags. Right-click / middle-click on
      // the handle should pass through to the browser default.
      if (event.button !== 0) {
        return;
      }
      const wrapper = wrapperRef.current;
      if (wrapper === null) {
        return;
      }
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      handle.dataset.dragging = 'true';
      const rect = wrapper.getBoundingClientRect();
      const startX = event.clientX;
      const startRatio = leftRatioRef.current;

      const onPointerMove = (ev: PointerEvent): void => {
        if (rect.width <= 0) {
          return;
        }
        const next = startRatio + (ev.clientX - startX) / rect.width;
        const clamped = Math.max(
          MIN_SPLIT_RATIO,
          Math.min(MAX_SPLIT_RATIO, next)
        );
        setLeftRatio(clamped);
      };
      const onPointerEnd = (ev: PointerEvent): void => {
        handle.releasePointerCapture(ev.pointerId);
        delete handle.dataset.dragging;
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerEnd);
        handle.removeEventListener('pointercancel', onPointerEnd);
        // Only persist on drag-end so a quick drag isn't followed by a
        // burst of writes for every intermediate position.
        writeStoredSplitRatio(leftRatioRef.current);
      };
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerEnd);
      handle.addEventListener('pointercancel', onPointerEnd);
    },
    []
  );

  const handleResizerDoubleClick = React.useCallback(() => {
    setLeftRatio(DEFAULT_SPLIT_RATIO);
    writeStoredSplitRatio(DEFAULT_SPLIT_RATIO);
  }, []);

  if (loading) {
    return <div className="jp-xtralab-DiffWidget-status">Loading diff…</div>;
  }
  if (error !== null) {
    return (
      <div className="jp-xtralab-DiffWidget-status" data-error="true">
        {error}
      </div>
    );
  }
  if (isBinary) {
    return (
      <div className="jp-xtralab-DiffWidget-status">
        Binary file — diff not supported.
      </div>
    );
  }
  if (imageType !== null) {
    // `oldText`/`newText` carry the two revisions as base64 here. The
    // image view owns its own layout and mode selector, so it does not
    // use the split resizer or the notebook/JSON toggle.
    return (
      <div className="jp-xtralab-DiffWidget-content">
        <ImageDiffView
          reference={oldText}
          challenger={newText}
          fileType={imageType}
        />
      </div>
    );
  }
  if (!showNotebookView && !showFileDiff) {
    return (
      <div className="jp-xtralab-DiffWidget-status">No content to diff.</div>
    );
  }

  // Custom property set on the diffs-container host. The library's
  // shadow-root rule consumes it via `var(--xtralab-split-cols, …)` (see
  // SPLIT_RESIZE_CSS) and recomputes the column tracks instantly. Only
  // relevant in the file-diff path; the notebook view doesn't use it.
  const leftPercent = leftRatio * 100;
  const hostStyle = {
    '--xtralab-split-cols': `${leftPercent}% ${100 - leftPercent}%`
  } as React.CSSProperties;

  return (
    <div className="jp-xtralab-DiffWidget-content">
      <div ref={wrapperRef} className="jp-xtralab-DiffWidget-body">
        <div className="jp-xtralab-DiffWidget-scroll">
          {showNotebookView && notebookDiff !== null ? (
            <NotebookDiffView
              diff={notebookDiff}
              dark={dark}
              pierreTheme={pierreTheme}
              rendermime={rendermime}
            />
          ) : showFileDiff && metadata !== null ? (
            <FileDiff<IHunkActionAnnotation>
              fileDiff={metadata}
              lineAnnotations={lineAnnotations}
              renderAnnotation={renderAnnotation}
              style={hostStyle}
              // Disable the worker pool: JupyterLab's webpack federation
              // pipeline doesn't ship the library's
              // `@pierre/diffs/worker/worker.js` file at a URL the worker
              // bootstrap can resolve from, so leaving the pool enabled
              // crashes on instantiation. Running on the main thread is
              // fine for the small files git diffs typically operate on.
              disableWorkerPool={true}
              options={{
                diffStyle,
                // Drop the file header — the tab title already shows the
                // file name and the panel header carries the change
                // context.
                disableFileHeader: true,
                theme: resolveDiffTheme(dark, pierreTheme),
                themeType: dark ? 'dark' : 'light',
                // Inject the column-resize override into the shadow root
                // via the library's `@layer unsafe` channel. Keeping the
                // string constant lets the library short-circuit the
                // re-render path it uses when this option actually
                // changes.
                unsafeCSS: SPLIT_RESIZE_CSS
              }}
            />
          ) : null}
        </div>
        {showFileDiff && diffStyle === 'split' ? (
          <div
            className="jp-xtralab-DiffWidget-resizer"
            style={{ left: `${leftPercent}%` }}
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(leftPercent)}
            aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
            aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
            title="Drag to resize the diff panes (double-click to reset)"
            onPointerDown={handleResizerPointerDown}
            onDoubleClick={handleResizerDoubleClick}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Segmented Notebook/JSON selector. Hosts mount this into whatever toolbar
 * they own (the launcher's `MainAreaWidget` toolbar, or the
 * `jupyterlab-git`-provided diff toolbar) and drive its value/visibility
 * from the same state they pass to {@link DiffSurface}.
 */
export function NotebookViewModeControl(props: {
  mode: NotebookDiffViewMode;
  available: boolean;
  onChange: (mode: NotebookDiffViewMode) => void;
}): React.ReactElement {
  const { mode, available, onChange } = props;
  if (!available) {
    return <></>;
  }
  return (
    <div
      className="jp-xtralab-DiffWidget-segmented"
      role="tablist"
      aria-label="Notebook diff view mode"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'notebook'}
        data-active={mode === 'notebook'}
        className="jp-xtralab-DiffWidget-segmentedButton"
        onClick={() => onChange('notebook')}
      >
        Notebook
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'json'}
        data-active={mode === 'json'}
        className="jp-xtralab-DiffWidget-segmentedButton"
        onClick={() => onChange('json')}
      >
        JSON
      </button>
    </div>
  );
}

/**
 * Split / unified glyphs, inlined from the `@pierre/diffs` icon sprite
 * (`diffs-icon-diff-split` / `diffs-icon-diff-unified`) so the toggle looks
 * like the one on the library's own docs site without depending on the
 * sprite sheet being injected into the document. `currentColor` lets the
 * segmented-button styling drive the fill (including the active state).
 */
function DiffSplitIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M14 0H8.5v16H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2m-1.5 6.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0" />
      <path
        d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5.5V0zm.5 7.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1"
        opacity=".3"
      />
    </svg>
  );
}

function DiffUnifiedIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16 14a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5h16zm-8-4a.5.5 0 0 0-.5.5v1h-1a.5.5 0 0 0 0 1h1v1a.5.5 0 0 0 1 0v-1h1a.5.5 0 0 0 0-1h-1v-1A.5.5 0 0 0 8 10"
        clipRule="evenodd"
      />
      <path
        fillRule="evenodd"
        d="M14 0a2 2 0 0 1 2 2v5.5H0V2a2 2 0 0 1 2-2zM6.5 3.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z"
        clipRule="evenodd"
        opacity=".4"
      />
    </svg>
  );
}

/**
 * Segmented Split/Unified selector. Mirrors {@link NotebookViewModeControl}:
 * hosts mount it into their own toolbar and drive its value/visibility from
 * the same state they pass to {@link DiffSurface}. Only meaningful while the
 * textual/code file diff is the active view, so `available` mirrors the
 * surface's `onFileDiffActiveChange`.
 */
export function DiffStyleControl(props: {
  diffStyle: DiffStyle;
  available: boolean;
  onChange: (style: DiffStyle) => void;
}): React.ReactElement {
  const { diffStyle, available, onChange } = props;
  if (!available) {
    return <></>;
  }
  return (
    <div
      className="jp-xtralab-DiffWidget-segmented"
      role="tablist"
      aria-label="Diff view style"
    >
      <button
        type="button"
        role="tab"
        aria-selected={diffStyle === 'split'}
        data-active={diffStyle === 'split'}
        className="jp-xtralab-DiffWidget-segmentedButton jp-xtralab-DiffWidget-segmentedButton-icon"
        title="Split (side-by-side) view"
        aria-label="Split view"
        onClick={() => onChange('split')}
      >
        <DiffSplitIcon />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={diffStyle === 'unified'}
        data-active={diffStyle === 'unified'}
        className="jp-xtralab-DiffWidget-segmentedButton jp-xtralab-DiffWidget-segmentedButton-icon"
        title="Unified (inline) view"
        aria-label="Unified view"
        onClick={() => onChange('unified')}
      >
        <DiffUnifiedIcon />
      </button>
    </div>
  );
}
