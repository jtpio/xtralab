import * as React from 'react';

import { IThemeManager, Notification } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { TranslationBundle } from '@jupyterlab/translation';
import { undoIcon } from '@jupyterlab/ui-components';
import { EditProvider, FileDiff } from '@pierre/diffs/react';
import { Editor, type EditorOptions } from '@pierre/diffs/edit';
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
import { DiffWorkerPoolProvider } from './diffWorkerPool';

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
  /**
   * Read the current working-tree text through the same server path the diff
   * baseline came from (a missing file reads as `''`). Checked right before a
   * discard writes, so a rebuilt file based on a stale diff — the file changed
   * on disk since it was loaded, e.g. by a coding agent — reloads the view
   * instead of silently reverting the external change.
   */
  readDiskText: () => Promise<string>;
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
  /**
   * Read the current working-tree text through the same server path the diff
   * baseline came from (a missing file reads as `''`). Checked right before
   * every autosave: when the on-disk text no longer matches the last text this
   * session confirmed, someone else — typically a coding agent — wrote the
   * file, and blindly saving would revert their change. The check is
   * best-effort (read and write are separate requests), but it closes the
   * whole-session window during which the snapshot goes stale.
   */
  readDiskText: () => Promise<string>;
  /**
   * Called when the user resolves an autosave conflict by keeping the file on
   * disk. The host ends the edit session and reloads the diff; the session's
   * unsaved edits are intentionally dropped.
   */
  onConflictDiscard?: () => void;
}

/**
 * Live save state surfaced to the user while an edit session is active.
 * `conflict` means the file changed on disk under the session; autosaving
 * stays paused until the user resolves it through the conflict notification.
 */
type EditSaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

/**
 * Quiet period after the last keystroke before an edit session autosaves.
 */
const EDIT_AUTOSAVE_DELAY_MS = 500;

/**
 * Editor factory handed to `EditProvider`; the library components call it when
 * an edit session starts, passing the surface's `editorOptions`.
 */
function createEditor(
  options: EditorOptions<IHunkActionAnnotation>
): Editor<IHunkActionAnnotation> {
  return new Editor<IHunkActionAnnotation>(options);
}

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
  return (
    <DiffWorkerPoolProvider dark={props.dark} pierreTheme={props.pierreTheme}>
      <DiffSurfaceContent {...props} />
    </DiffWorkerPoolProvider>
  );
}

/**
 * The diff views themselves, mounted inside the worker-pool provider so
 * every `FileDiff` below picks the pool up from context.
 */
function DiffSurfaceContent(props: IDiffSurfaceProps): React.ReactElement {
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
      // A discard rewrites the whole file from the loaded diff, so a view
      // that went stale (the file changed on disk since load — e.g. a coding
      // agent wrote it) would silently revert that external change. Reload
      // the diff instead and let the user retry against current content.
      let diskText: string;
      try {
        diskText = await hunkDiscard.readDiskText();
      } catch (err) {
        console.error(
          'xtralab: failed to read the file before discarding a hunk',
          err
        );
        return;
      }
      if (diskText !== newText) {
        Notification.warning(
          trans.__('%1 changed on disk — the diff has been reloaded.', newName)
        );
        hunkDiscard.onAfterSave();
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
    [hunkDiscard, metadata, newText, newName, trans]
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

  // Remount the read-only file diff whenever the compared contents actually
  // change. The library's in-place transition between two different diffs is
  // unreliable (it can paint panes from the outgoing diff, or throw in its
  // hunk renderer), while a fresh mount always renders the new state
  // correctly. Value comparison keeps the key stable across re-renders and
  // refreshes that return identical text, so scroll position survives those.
  const contentEpochRef = React.useRef(0);
  const lastContentRef = React.useRef<[string, string]>([oldText, newText]);
  const fileDiffKey = React.useMemo(() => {
    const [prevOld, prevNew] = lastContentRef.current;
    if (prevOld !== oldText || prevNew !== newText) {
      lastContentRef.current = [oldText, newText];
      contentEpochRef.current += 1;
    }
    return contentEpochRef.current;
  }, [oldText, newText]);

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
                fileName={newName}
                edit={edit}
                trans={trans}
              />
            ) : (
              <FileDiff<IHunkActionAnnotation>
                key={fileDiffKey}
                fileDiff={metadata}
                lineAnnotations={lineAnnotations}
                renderAnnotation={renderAnnotation}
                style={hostStyle}
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
 * editor. Hands {@link FileDiff} a `@pierre/diffs` {@link Editor} factory
 * through {@link EditProvider} (which the library requires whenever `edit` is
 * set) and autosaves edits to the working-tree file.
 *
 * The editor owns the live DOM while mounted, so the rendered diff is frozen to
 * its mount-time snapshot and memoized: neither save-status re-renders nor the
 * host adopting newly-saved text (which it does via {@link IDiffEdit.onSaved})
 * can re-hydrate it mid-edit.
 *
 * The frozen snapshot means the session can go stale: an external writer (a
 * coding agent, an editor tab) may change the file underneath it. Every
 * autosave therefore verifies the on-disk text first and pauses as a conflict
 * — with an overwrite-or-discard choice — rather than writing a stale base
 * over someone else's change (see {@link IDiffEdit.readDiskText}).
 */
function EditableFileDiff(props: {
  initialFileDiff: FileDiffMetadata;
  initialOptions: FileDiffOptions<IHunkActionAnnotation>;
  hostStyle: React.CSSProperties;
  initialText: string;
  fileName: string;
  edit: IDiffEdit;
  trans: TranslationBundle;
}): React.ReactElement {
  const {
    initialFileDiff,
    initialOptions,
    hostStyle,
    initialText,
    edit,
    trans
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

  // Latest props behind refs so the once-created editor and any callback that
  // fires after unmount always see the current values.
  const editPropRef = React.useRef(edit);
  const transRef = React.useRef(props.trans);
  const fileNameRef = React.useRef(props.fileName);
  React.useEffect(() => {
    editPropRef.current = edit;
    transRef.current = props.trans;
    fileNameRef.current = props.fileName;
  }, [edit, props.trans, props.fileName]);

  const [saveState, setSaveState] = React.useState<EditSaveState>('idle');

  // Set while an unresolved conflict notification is showing, so retries do
  // not stack toasts. Cleared when the user acts on it or a write lands.
  const conflictToastRef = React.useRef<string | null>(null);
  // One save may bypass the disk check: set by the conflict notification's
  // "Overwrite" action, whose whole point is to write over the external change.
  const skipConflictGuardRef = React.useRef(false);
  // Set when the user resolves a conflict by keeping the file on disk: the
  // session is being torn down and nothing may be written anymore — including
  // the teardown flush, which would otherwise re-save the abandoned edits.
  const abandonedRef = React.useRef(false);
  // `persist` runs before `notifyConflict` can be defined (they reference each
  // other), so it reaches the latest one through a ref.
  const notifyConflictRef = React.useRef<() => void>(() => undefined);

  // Persist edits to disk, single-flight: at most one save runs at a time and
  // the loop drains to the latest text, so writes can never overlap or land
  // out of order. Each write is preceded by a disk check (see
  // {@link IDiffEdit.readDiskText}): if the file no longer holds the last text
  // this session confirmed, an external writer got there first and the save
  // pauses as a conflict instead of reverting their change. The on-disk
  // baseline (and the host's, via onSaved) only advances for text a write
  // actually confirmed — or that the disk already holds — so a failed save
  // never reads back as saved. Stable, so the once-created editor and the
  // teardown flush call it directly; its state updates after unmount are
  // React no-ops.
  const persist = React.useCallback(async () => {
    if (savingRef.current || abandonedRef.current) {
      return;
    }
    savingRef.current = true;
    try {
      let didSave = false;
      while (latestTextRef.current !== savedTextRef.current) {
        const text = latestTextRef.current;
        setSaveState('saving');
        if (skipConflictGuardRef.current) {
          skipConflictGuardRef.current = false;
        } else {
          let diskText: string;
          try {
            diskText = await editPropRef.current.readDiskText();
          } catch (err) {
            console.error(
              'xtralab: failed to read the file before saving',
              err
            );
            setSaveState('error');
            return;
          }
          if (diskText === text) {
            // The disk already holds the editor text (the external writer and
            // the session converged): adopt it without writing.
            savedTextRef.current = text;
            editPropRef.current.onSaved?.(text);
            didSave = true;
            continue;
          }
          if (diskText !== savedTextRef.current) {
            setSaveState('conflict');
            notifyConflictRef.current();
            return;
          }
        }
        try {
          await editPropRef.current.save(text);
        } catch (err) {
          console.error('xtralab: failed to save edited file', err);
          setSaveState('error');
          return;
        }
        savedTextRef.current = text;
        editPropRef.current.onSaved?.(text);
        didSave = true;
      }
      // An unconsumed bypass (an "Overwrite" clicked after the edits were
      // undone) must not exempt a later, unrelated save from the disk check.
      skipConflictGuardRef.current = false;
      if (didSave) {
        if (conflictToastRef.current !== null) {
          Notification.dismiss(conflictToastRef.current);
          conflictToastRef.current = null;
        }
        setSaveState('saved');
      }
    } finally {
      savingRef.current = false;
    }
  }, []);

  // Pending autosave timer. The editor reports every applied change
  // synchronously (no built-in debounce), so this component owns the delay
  // between the last keystroke and the disk write.
  const saveTimerRef = React.useRef<number | null>(null);

  const cancelPendingSave = React.useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  // Surface an autosave conflict and let the user pick a side; nothing is
  // written while the notification is pending. Sticky (no auto-close) because
  // dismissing it silently would leave the session paused with no explanation,
  // and it must survive a closed tab — its actions are the only way left to
  // recover the unsaved edits. Both actions stay functional after unmount:
  // `persist` and the host callbacks only touch refs and server state.
  const notifyConflict = React.useCallback(() => {
    if (conflictToastRef.current !== null) {
      return;
    }
    const trans = transRef.current;
    conflictToastRef.current = Notification.warning(
      trans.__(
        '%1 changed on disk while you were editing it.',
        fileNameRef.current
      ),
      {
        autoClose: false,
        actions: [
          {
            label: trans.__('Overwrite'),
            caption: trans.__('Replace the file on disk with your edited text'),
            displayType: 'warn',
            callback: () => {
              conflictToastRef.current = null;
              skipConflictGuardRef.current = true;
              void persist();
            }
          },
          {
            label: trans.__('Discard my edits'),
            caption: trans.__('Keep the file on disk and reload the diff'),
            callback: () => {
              conflictToastRef.current = null;
              abandonedRef.current = true;
              cancelPendingSave();
              editPropRef.current.onConflictDiscard?.();
            }
          }
        ]
      }
    );
  }, [cancelPendingSave, persist]);
  React.useEffect(() => {
    notifyConflictRef.current = notifyConflict;
  }, [notifyConflict]);

  // Fires on every applied edit. `file.contents` lazily reads the library's
  // document; if that ever fails there is nothing readable to persist, so
  // skip. The captured text is what teardown flushes, so it is always the
  // live document even when the autosave timer never fires.
  const handleEditorChange = React.useCallback(
    (file: FileContents) => {
      let contents: string;
      try {
        contents = file.contents;
      } catch {
        return;
      }
      latestTextRef.current = contents;
      if (contents === savedTextRef.current) {
        // Back in sync with disk (an undo to the saved text): nothing left
        // to write. Don't override a save still draining — its loop settles
        // state, and may still need a corrective write back to this content.
        cancelPendingSave();
        if (!savingRef.current) {
          setSaveState('idle');
        }
        return;
      }
      cancelPendingSave();
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void persist();
      }, EDIT_AUTOSAVE_DELAY_MS);
    },
    [cancelPendingSave, persist]
  );

  const editorOptions = React.useMemo<EditorOptions<IHunkActionAnnotation>>(
    () => ({
      onChange: handleEditorChange,
      // Place the caret on the first visible editable line so the toggle is
      // immediately typable; preventScroll keeps the reading position.
      onAttach: editor => {
        editor.focus({ lineNumber: 'first-visible', preventScroll: true });
      }
    }),
    [handleEditorChange]
  );

  // On teardown (toggle off, file swap, tab close): flush whatever the last
  // onChange delivered instead of waiting out the autosave delay. The
  // library tears the editor itself down when the edit session ends.
  React.useEffect(() => {
    return () => {
      cancelPendingSave();
      void persist();
    };
  }, [cancelPendingSave, persist]);

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
        cancelPendingSave();
        void persist();
      }
    },
    [cancelPendingSave, persist]
  );

  // Memoized so only a split-resize (a hostStyle change) re-renders the
  // library component — which then early-returns off the unchanged snapshot —
  // while status and host-baseline updates leave it untouched.
  const diffElement = React.useMemo(
    () => (
      <EditProvider createEditor={createEditor}>
        <FileDiff<IHunkActionAnnotation>
          fileDiff={fileDiff}
          edit={true}
          editorOptions={editorOptions}
          // Opt out of the worker pool: this surface mounts straight into an
          // edit session, so a synchronous main-thread render produces
          // editor-compatible markup immediately instead of a pooled paint
          // the attach would re-render right away.
          disableWorkerPool={true}
          style={hostStyle}
          options={options}
        />
      </EditProvider>
    ),
    [editorOptions, fileDiff, options, hostStyle]
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
        <EditSaveStatus state={saveState} trans={trans} />
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
  trans: TranslationBundle;
}): React.ReactElement | null {
  const { state, trans } = props;
  if (state === 'idle') {
    return null;
  }
  const label =
    state === 'saving'
      ? trans.__('Saving…')
      : state === 'saved'
        ? trans.__('Saved')
        : state === 'conflict'
          ? trans.__('File changed on disk')
          : trans.__('Save failed');
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
  trans: TranslationBundle;
}): React.ReactElement {
  const { editing, available, onChange, trans } = props;
  if (!available) {
    return <></>;
  }
  const label = editing
    ? trans.__('Done editing')
    : trans.__('Edit the file directly');
  return (
    <div className="jp-xtralab-DiffWidget-segmented">
      <button
        type="button"
        aria-pressed={editing}
        data-active={editing}
        className="jp-xtralab-DiffWidget-segmentedButton jp-xtralab-DiffWidget-segmentedButton-icon"
        title={label}
        aria-label={label}
        onClick={() => onChange(!editing)}
      >
        <EditModeIcon />
      </button>
    </div>
  );
}
