import * as React from 'react';

import { IThemeManager } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { TranslationBundle } from '@jupyterlab/translation';
import { undoIcon } from '@jupyterlab/ui-components';
import { EditorProvider, FileDiff } from '@pierre/diffs/react';
import { Editor } from '@pierre/diffs/editor';
import {
  diffAcceptRejectHunk,
  parseDiffFromFile,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type FileDiffOptions,
  type SelectedLineRange
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
interface IHunkDiscard {
  enabled: boolean;
  save: (fullText: string) => Promise<void>;
  onAfterSave: () => void;
}

/**
 * Optional direct-editing wiring. When supplied and {@link IDiffEdit.canEdit}
 * holds, the new (additions) side of the textual diff becomes an in-place
 * editor: edits autosave to the working-tree file through {@link IDiffEdit.save}
 * (the host owns the on-disk path), and {@link IDiffEdit.onSaved} reports the
 * text after each confirmed write so the host can keep the read-only baseline
 * in sync without a server round-trip.
 */
export interface IDiffEdit {
  /**
   * Whether the new side maps to a savable working-tree text file. Editing is
   * only offered when this holds (e.g. not for staged/index or binary diffs).
   */
  canEdit: boolean;
  /**
   * Persist the full edited text to disk. Must not trigger a diff reload — the
   * editor owns the live view while a session is active.
   */
  save: (fullText: string) => Promise<void>;
  /**
   * Called with the full text after each *confirmed* disk write (a failed save
   * never advances it). The host adopts it as the read-only baseline so that
   * view tracks disk both during and after the session.
   */
  onSaved?: (fullText: string) => void;
}

/**
 * Live save state surfaced to the user while an edit session is active.
 */
type EditSaveState = 'idle' | 'saving' | 'saved' | 'error';

interface IDiffSurfaceProps {
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
  /**
   * When provided, the textual/code file diff gets line selection: clicking
   * or dragging over the line numbers selects a range, and a gutter "+"
   * button appears on the hovered/selected lines. Clicking that button
   * invokes this callback with the selected range and the button's viewport
   * rectangle (to anchor a popup to), `null` when it cannot be measured.
   */
  onLineAsk?: (range: SelectedLineRange, anchor: DOMRect | null) => void;
  /**
   * Whether the host has the edit toggle switched on. Only takes effect while
   * the editable file diff is the active view (see {@link IDiffEdit.canEdit}
   * and {@link onEditActiveChange}).
   */
  editing?: boolean;
  /**
   * Optional direct-editing wiring; omit for a non-editable diff.
   */
  edit?: IDiffEdit;
  /**
   * Called whenever the diff becomes (un)editable, so the host can show/hide
   * its Edit toggle. True only for a working-tree textual/code file diff.
   */
  onEditActiveChange?: (active: boolean) => void;
  /**
   * Translation bundle for user-facing strings.
   */
  trans: TranslationBundle;
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
    hunkDiscard,
    onLineAsk,
    editing,
    edit,
    onEditActiveChange,
    trans
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

  // Editing applies only to a working-tree textual/code file diff: not the
  // rendered notebook view, and not a notebook's raw JSON (editing nbformat by
  // hand is too easy to corrupt), and only when the host wired a save path.
  const editActive =
    edit?.canEdit === true && showFileDiff && !isNotebookPath(newName);

  React.useEffect(() => {
    onEditActiveChange?.(editActive);
  }, [onEditActiveChange, editActive]);

  // The toggle only does anything while the file is actually editable.
  const effectiveEditing = editActive && editing === true;

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
            title={trans.__("Discard this hunk's changes")}
            aria-label={trans.__('Discard hunk')}
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
    [handleDiscardHunk, trans]
  );

  const handleGutterUtilityClick = React.useCallback(
    (range: SelectedLineRange) => {
      if (onLineAsk === undefined) {
        return;
      }
      // Anchor to the gutter "+" button that was just clicked. It lives in
      // the `@pierre/diffs` shadow root (which is open), parked on the
      // hovered/selected line's number element.
      const slot = wrapperRef.current
        ?.querySelector('diffs-container')
        ?.shadowRoot?.querySelector('[data-gutter-utility-slot]');
      onLineAsk(
        range,
        slot instanceof Element ? slot.getBoundingClientRect() : null
      );
    },
    [onLineAsk]
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

  const handleResizerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.1 : 0.01;
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowLeft':
          next = leftRatioRef.current - step;
          break;
        case 'ArrowRight':
          next = leftRatioRef.current + step;
          break;
        case 'Home':
          next = MIN_SPLIT_RATIO;
          break;
        case 'End':
          next = MAX_SPLIT_RATIO;
          break;
      }
      if (next === null) {
        return;
      }
      event.preventDefault();
      const clamped = Math.max(
        MIN_SPLIT_RATIO,
        Math.min(MAX_SPLIT_RATIO, next)
      );
      setLeftRatio(clamped);
      writeStoredSplitRatio(clamped);
    },
    []
  );

  // Fraction of width given to the deletions (left) pane, expressed as a
  // percentage for both the shadow-root column override and the resizer.
  const leftPercent = leftRatio * 100;

  // Custom property the library's shadow-root rule consumes via
  // `var(--xtralab-split-cols, …)` (see SPLIT_RESIZE_CSS) to recompute the
  // column tracks instantly. Memoized so its identity only changes on resize,
  // which keeps the editable diff subtree (below) from re-rendering needlessly.
  const hostStyle = React.useMemo<React.CSSProperties>(
    () =>
      ({
        '--xtralab-split-cols': `${leftPercent}% ${100 - leftPercent}%`
      }) as React.CSSProperties,
    [leftPercent]
  );

  // Options shared by the read-only and editable file-diff renders. A stable
  // identity lets the library short-circuit its option-equality check on
  // unrelated re-renders; the editable session captures the mount-time value
  // for its whole lifetime.
  const fileDiffOptions = React.useMemo<FileDiffOptions<IHunkActionAnnotation>>(
    () => ({
      diffStyle,
      // Drop the file header — the tab title already shows the file name and
      // the panel header carries the change context.
      disableFileHeader: true,
      theme: resolveDiffTheme(dark, pierreTheme),
      themeType: dark ? 'dark' : 'light',
      // Inject the column-resize override into the shadow root via the
      // library's `@layer unsafe` channel. Keeping the string constant lets
      // the library short-circuit its re-render path when this is unchanged.
      unsafeCSS: SPLIT_RESIZE_CSS
    }),
    [diffStyle, dark, pierreTheme]
  );

  // The read-only render additionally wires line selection + the gutter "+"
  // button that feed the ask-agent popup; only when a handler exists so a
  // plain diff keeps its passive gutter. Kept out of the shared options so an
  // editable session (which freezes its options at mount) never captures it.
  const readOnlyFileDiffOptions = React.useMemo<
    FileDiffOptions<IHunkActionAnnotation>
  >(
    () => ({
      ...fileDiffOptions,
      ...(onLineAsk !== undefined
        ? {
            enableLineSelection: true,
            enableGutterUtility: true,
            onGutterUtilityClick: handleGutterUtilityClick
          }
        : {})
    }),
    [fileDiffOptions, onLineAsk, handleGutterUtilityClick]
  );

  if (loading) {
    return (
      <div className="jp-xtralab-DiffWidget-status">
        {trans.__('Loading diff…')}
      </div>
    );
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
        {trans.__('Binary file — diff not supported.')}
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
          trans={trans}
        />
      </div>
    );
  }
  if (!showNotebookView && !showFileDiff) {
    return (
      <div className="jp-xtralab-DiffWidget-status">
        {trans.__('No content to diff.')}
      </div>
    );
  }

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
              trans={trans}
            />
          ) : showFileDiff && metadata !== null ? (
            effectiveEditing && edit !== undefined ? (
              <EditableFileDiff
                initialFileDiff={metadata}
                initialOptions={fileDiffOptions}
                hostStyle={hostStyle}
                initialText={newText}
                save={edit.save}
                onSaved={edit.onSaved}
              />
            ) : (
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
                options={readOnlyFileDiffOptions}
              />
            )
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
            aria-label={trans.__('Resize the diff panes')}
            tabIndex={0}
            title={trans.__(
              'Drag to resize the diff panes (double-click to reset)'
            )}
            onPointerDown={handleResizerPointerDown}
            onDoubleClick={handleResizerDoubleClick}
            onKeyDown={handleResizerKeyDown}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The new (additions) side of a textual file diff, rendered as an in-place
 * editor. Wires a `@pierre/diffs` {@link Editor} into the {@link FileDiff}
 * through {@link EditorProvider} (which the library requires whenever
 * `contentEditable` is set) and autosaves edits to the working-tree file.
 *
 * The editor owns the live DOM while mounted, so the rendered diff is frozen to
 * its mount-time snapshot and memoized: neither save-status re-renders nor the
 * host adopting newly-saved text (which it does via {@link onSaved}) can
 * re-hydrate it mid-edit.
 */
function EditableFileDiff(props: {
  initialFileDiff: FileDiffMetadata;
  initialOptions: FileDiffOptions<IHunkActionAnnotation>;
  hostStyle: React.CSSProperties;
  initialText: string;
  save: (fullText: string) => Promise<void>;
  onSaved?: (fullText: string) => void;
}): React.ReactElement {
  const {
    initialFileDiff,
    initialOptions,
    hostStyle,
    initialText,
    save,
    onSaved
  } = props;

  // The diff is frozen to its mount-time snapshot: the editor takes over live
  // rendering of edits, and the host re-deriving the diff from newly-saved
  // text must not re-hydrate it. Options are frozen for the session too — a
  // diffStyle/theme change would otherwise force the library to repaint from
  // the frozen snapshot while the editor is attached, desyncing the view from
  // the live document — so the host hides the layout toggle while editing,
  // and theme changes apply on exit.
  const [fileDiff] = React.useState(initialFileDiff);
  const [options] = React.useState(initialOptions);

  // The text currently in the editor and the text last *confirmed* on disk.
  // Held in refs so neither typing nor save bookkeeping re-renders this
  // widget. The initial on-disk text is the save baseline.
  const latestTextRef = React.useRef(initialText);
  const savedTextRef = React.useRef(initialText);

  // Guards the single-flight save loop in `persist`.
  const savingRef = React.useRef(false);

  // Latest callbacks behind refs so the once-created editor and any callback
  // that fires after unmount always see the current props.
  const saveRef = React.useRef(save);
  const onSavedRef = React.useRef(onSaved);
  React.useEffect(() => {
    saveRef.current = save;
    onSavedRef.current = onSaved;
  }, [save, onSaved]);

  const [saveState, setSaveState] = React.useState<EditSaveState>('idle');

  // Persist edits to disk, single-flight: at most one save runs at a time and
  // the loop drains to the latest text, so writes can never overlap or land
  // out of order. The on-disk baseline (and the host's, via onSaved) only
  // advances for text a write actually confirmed, so a failed save never reads
  // back as saved. Stable, so the once-created editor and the teardown flush
  // call it directly; its state updates after unmount are React no-ops.
  const persist = React.useCallback(async () => {
    if (savingRef.current) {
      return;
    }
    savingRef.current = true;
    try {
      let didSave = false;
      while (latestTextRef.current !== savedTextRef.current) {
        const text = latestTextRef.current;
        setSaveState('saving');
        try {
          await saveRef.current(text);
        } catch (err) {
          console.error('xtralab: failed to save edited file', err);
          setSaveState('error');
          return;
        }
        savedTextRef.current = text;
        onSavedRef.current?.(text);
        didSave = true;
      }
      if (didSave) {
        setSaveState('saved');
      }
    } finally {
      savingRef.current = false;
    }
  }, []);

  // One editor per session, created lazily so it survives status re-renders.
  // The library already debounces onChange (~500ms), so each call is a settled
  // edit we can persist directly. `file.contents` lazily reads the library's
  // document; if that ever fails there is nothing readable to persist, so skip
  // rather than let the error escape into the library's debounce timer.
  const [editor] = React.useState(
    () =>
      new Editor<IHunkActionAnnotation>({
        onChange: (file: FileContents) => {
          let contents: string;
          try {
            contents = file.contents;
          } catch {
            return;
          }
          latestTextRef.current = contents;
          if (contents === savedTextRef.current) {
            // Back in sync with disk (the attach echo, or an undo to it).
            // Don't override a save still draining — its loop settles state,
            // and may still need a corrective write back to this content.
            if (!savingRef.current) {
              setSaveState('idle');
            }
            return;
          }
          void persist();
        }
      })
  );

  // On teardown (toggle off, file swap, tab close): flush whatever the last
  // onChange delivered, then drop the editor. The library does not cancel its
  // pending onChange debounce on cleanUp and the contents getter stays valid,
  // so a final onChange can still fire afterwards and persist the last edits.
  React.useEffect(() => {
    return () => {
      void persist();
      editor.cleanUp();
    };
  }, [editor, persist]);

  // Let the "Saved" confirmation fade back to the steady state on its own; a
  // persistent badge would just be noise once the write has landed.
  React.useEffect(() => {
    if (saveState !== 'saved') {
      return;
    }
    const timer = setTimeout(() => setSaveState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [saveState]);

  // Ctrl/Cmd+S persists immediately. Together with `data-lm-suppress-shortcuts`
  // below — which makes Lumino skip its own keybindings for events from here,
  // so its document-level handler can't run first — this keeps the keystroke
  // from reaching JupyterLab's save command or the browser's save dialog.
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        void persist();
      }
    },
    [persist]
  );

  // Memoized so only a split-resize (a hostStyle change) re-renders the
  // library component — which then early-returns off the unchanged snapshot —
  // while status and host-baseline updates leave it untouched.
  const diffElement = React.useMemo(
    () => (
      <EditorProvider editor={editor}>
        <FileDiff<IHunkActionAnnotation>
          fileDiff={fileDiff}
          contentEditable={true}
          // As in the read-only render, the worker pool can't bootstrap under
          // JupyterLab's federation, so the editor tokenizes on the main
          // thread.
          disableWorkerPool={true}
          style={hostStyle}
          options={options}
        />
      </EditorProvider>
    ),
    [editor, fileDiff, options, hostStyle]
  );

  return (
    <div
      className="jp-xtralab-DiffWidget-editRegion"
      data-lm-suppress-shortcuts="true"
      onKeyDownCapture={handleKeyDown}
    >
      {/* Sticky, zero-height bar so the save indicator stays pinned to the top
          of the viewport while the file scrolls, without displacing the diff. */}
      <div className="jp-xtralab-DiffWidget-saveStatusBar">
        <EditSaveStatus state={saveState} />
      </div>
      {diffElement}
    </div>
  );
}

/**
 * Small, unobtrusive save-state indicator shown while editing. Renders nothing
 * in the steady (`idle`) state so it only appears when there is something to
 * report.
 */
function EditSaveStatus(props: {
  state: EditSaveState;
}): React.ReactElement | null {
  const { state } = props;
  if (state === 'idle') {
    return null;
  }
  const label =
    state === 'saving'
      ? 'Saving…'
      : state === 'saved'
        ? 'Saved'
        : 'Save failed';
  return (
    <div
      className="jp-xtralab-DiffWidget-saveStatus"
      data-state={state}
      role="status"
      aria-live="polite"
    >
      {label}
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
  trans: TranslationBundle;
}): React.ReactElement {
  const { mode, available, onChange, trans } = props;
  if (!available) {
    return <></>;
  }
  return (
    <div
      className="jp-xtralab-DiffWidget-segmented"
      role="tablist"
      aria-label={trans.__('Notebook diff view mode')}
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'notebook'}
        data-active={mode === 'notebook'}
        className="jp-xtralab-DiffWidget-segmentedButton"
        onClick={() => onChange('notebook')}
      >
        {trans.__('Notebook')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'json'}
        data-active={mode === 'json'}
        className="jp-xtralab-DiffWidget-segmentedButton"
        onClick={() => onChange('json')}
      >
        {trans.__('JSON')}
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
 * surface's `onFileDiffActiveChange`. `disabled` keeps the toggle visible
 * but inert; hiding it would make the toolbar jump.
 */
export function DiffStyleControl(props: {
  diffStyle: DiffStyle;
  available: boolean;
  disabled?: boolean;
  onChange: (style: DiffStyle) => void;
  trans: TranslationBundle;
}): React.ReactElement {
  const { diffStyle, available, disabled = false, onChange, trans } = props;
  if (!available) {
    return <></>;
  }
  return (
    <div
      className="jp-xtralab-DiffWidget-segmented"
      role="tablist"
      aria-label={trans.__('Diff view style')}
    >
      <button
        type="button"
        role="tab"
        aria-selected={diffStyle === 'split'}
        data-active={diffStyle === 'split'}
        className="jp-xtralab-DiffWidget-segmentedButton jp-xtralab-DiffWidget-segmentedButton-icon"
        title={
          disabled
            ? trans.__('Unavailable while editing')
            : trans.__('Split (side-by-side) view')
        }
        aria-label={trans.__('Split view')}
        disabled={disabled}
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
        title={
          disabled
            ? trans.__('Unavailable while editing')
            : trans.__('Unified (inline) view')
        }
        aria-label={trans.__('Unified view')}
        disabled={disabled}
        onClick={() => onChange('unified')}
      >
        <DiffUnifiedIcon />
      </button>
    </div>
  );
}

/**
 * Pencil glyph for the edit toggle, inlined in the same style as the
 * split/unified icons so the control needs no injected sprite sheet.
 * `currentColor` lets the segmented-button styling drive the fill.
 */
function EditModeIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168zm.708 1.061L11.207 2.854 13.146 4.793l1.647-1.646zM12.439 5.5 10.5 3.561 4 10.061V10.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.439zm-9.263 4.323-.214.214-1.234 3.086 3.086-1.234.214-.214A.5.5 0 0 1 5 11.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.5.5 0 0 1-.5-.5z" />
    </svg>
  );
}

/**
 * Edit toggle. Mirrors {@link DiffStyleControl}: the host mounts it into its
 * own toolbar and drives value/visibility from the same state it passes to
 * {@link DiffSurface}. Only meaningful while a working-tree textual/code file
 * diff is the active view, so `available` mirrors the surface's
 * `onEditActiveChange`.
 */
export function EditModeControl(props: {
  editing: boolean;
  available: boolean;
  onChange: (editing: boolean) => void;
}): React.ReactElement {
  const { editing, available, onChange } = props;
  if (!available) {
    return <></>;
  }
  return (
    <div className="jp-xtralab-DiffWidget-segmented">
      <button
        type="button"
        aria-pressed={editing}
        data-active={editing}
        className="jp-xtralab-DiffWidget-segmentedButton jp-xtralab-DiffWidget-segmentedButton-icon"
        title={editing ? 'Done editing' : 'Edit the file directly'}
        aria-label={editing ? 'Done editing' : 'Edit the file directly'}
        onClick={() => onChange(!editing)}
      >
        <EditModeIcon />
      </button>
    </div>
  );
}
