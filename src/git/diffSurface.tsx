import * as React from 'react';

import { IThemeManager, Notification } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { TranslationBundle } from '@jupyterlab/translation';
import { undoIcon } from '@jupyterlab/ui-components';
import { EditProvider, FileDiff } from '@pierre/diffs/react';
import {
  Editor,
  type EditorOptions,
  type Position,
  type TextEdit
} from '@pierre/diffs/edit';
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
 * `renderAnnotation` callback. The read-only render targets a whole hunk by
 * index; the editable render targets one contiguous change block, so nearby
 * blocks merged into a single hunk keep their own discard buttons.
 */
interface IHunkActionAnnotation {
  hunkIndex: number;
  block?: {
    additions: number;
    deletions: number;
    additionLineIndex: number;
    deletionLineIndex: number;
  };
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
   * Read the current working-tree text (a missing file reads as `''`).
   * Checked before a discard writes so a stale view reloads instead of
   * silently reverting an external change.
   */
  readDiskText: () => Promise<string>;
}

/**
 * Direct-editing wiring: when supplied and {@link IDiffEdit.canEdit} holds,
 * the new side of the textual diff becomes an in-place editor that autosaves
 * to the working-tree file through the host.
 */
export interface IDiffEdit {
  /**
   * Whether the new side maps to a savable working-tree text file.
   */
  canEdit: boolean;
  /**
   * Persist the full edited text to disk, without triggering a diff reload.
   */
  save: (fullText: string) => Promise<void>;
  /**
   * Called with the full text after each confirmed disk write; the host
   * adopts it as the read-only baseline.
   */
  onSaved?: (fullText: string) => void;
  /**
   * Read the current working-tree text (a missing file reads as `''`).
   * Checked before every autosave so a stale session pauses as a conflict
   * instead of reverting an external write.
   */
  readDiskText: () => Promise<string>;
  /**
   * Called when the user resolves an autosave conflict by keeping the file on
   * disk; the host ends the session and reloads the diff.
   */
  onConflictDiscard?: () => void;
}

/**
 * Save state surfaced while editing. `conflict` pauses autosaving until the
 * user resolves it through the notification.
 */
type EditSaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

/**
 * Quiet period after the last keystroke before an edit session autosaves.
 */
const EDIT_AUTOSAVE_DELAY_MS = 500;

/**
 * Editor factory handed to `EditProvider` when an edit session starts.
 */
function createEditor(
  options: EditorOptions<IHunkActionAnnotation>
): Editor<IHunkActionAnnotation> {
  return new Editor<IHunkActionAnnotation>(options);
}

/**
 * Smallest single edit turning `before` into `after` (null when equal), as a
 * zero-based line/character range into `before`.
 */
function minimalTextEdit(before: string, after: string): TextEdit | null {
  if (before === after) {
    return null;
  }
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) {
    start++;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }
  const toPosition = (offset: number): Position => {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < offset; i++) {
      if (before.charCodeAt(i) === 10) {
        line++;
        lineStart = i + 1;
      }
    }
    return { line, character: offset - lineStart };
  };
  return {
    range: { start: toPosition(start), end: toPosition(beforeEnd) },
    newText: after.slice(start, afterEnd)
  };
}

/**
 * Inline "discard this change" annotation button, shared by the read-only
 * and editable diff renders.
 */
function HunkDiscardButton(props: {
  payload: IHunkActionAnnotation;
  onDiscard: (payload: IHunkActionAnnotation) => void;
  trans: TranslationBundle;
}): React.ReactElement {
  const { payload, onDiscard, trans } = props;
  return (
    <div className="jp-xtralab-DiffWidget-hunkAnnotation">
      <button
        type="button"
        className="jp-xtralab-DiffWidget-hunkButton"
        title={trans.__('Discard this change')}
        aria-label={trans.__('Discard change')}
        onClick={() => onDiscard(payload)}
      >
        <undoIcon.react
          tag="span"
          className="jp-xtralab-DiffWidget-hunkButton-icon"
          elementSize="normal"
        />
      </button>
    </div>
  );
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
   * Optional direct-editing wiring; omit for a non-editable diff.
   */
  edit?: IDiffEdit;
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
 * The diff views themselves, mounted inside the worker-pool provider.
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
    edit,
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

  // Editing applies only to a working-tree textual/code file diff; notebooks
  // are excluded (hand-editing nbformat is too easy to corrupt).
  const editActive =
    edit?.canEdit === true && showFileDiff && !isNotebookPath(newName);

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
      // If the file changed on disk since the diff loaded, a discard would
      // silently revert that external change — reload instead.
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

  const handleDiscardHunkVoid = React.useCallback(
    (payload: IHunkActionAnnotation) => {
      void handleDiscardHunk(payload.hunkIndex);
    },
    [handleDiscardHunk]
  );

  const renderAnnotation = React.useCallback(
    (
      annotation: DiffLineAnnotation<IHunkActionAnnotation>
    ): React.ReactNode => {
      if (annotation.metadata === undefined) {
        return null;
      }
      return (
        <HunkDiscardButton
          payload={annotation.metadata}
          onDiscard={handleDiscardHunkVoid}
          trans={trans}
        />
      );
    },
    [handleDiscardHunkVoid, trans]
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

  const leftPercent = leftRatio * 100;

  // Consumed inside the shadow root via `var(--xtralab-split-cols)` (see
  // SPLIT_RESIZE_CSS). Memoized so only a resize changes its identity.
  const hostStyle = React.useMemo<React.CSSProperties>(
    () =>
      ({
        '--xtralab-split-cols': `${leftPercent}% ${100 - leftPercent}%`
      }) as React.CSSProperties,
    [leftPercent]
  );

  // Remount the read-only diff when the compared contents change: the
  // library's in-place transition between diffs is unreliable, a fresh mount
  // is not. Value comparison keeps scroll across identical-text refreshes.
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

  // Shared by the read-only and editable renders; a stable identity lets the
  // library skip its option-equality check on unrelated re-renders. Line
  // selection + the ask-agent gutter button ride along when the host wired a
  // handler, in both renders.
  const fileDiffOptions = React.useMemo<FileDiffOptions<IHunkActionAnnotation>>(
    () => ({
      diffStyle,
      // The tab title and panel header already carry the file name.
      disableFileHeader: true,
      theme: resolveDiffTheme(dark, pierreTheme),
      themeType: dark ? 'dark' : 'light',
      unsafeCSS: SPLIT_RESIZE_CSS,
      ...(onLineAsk !== undefined
        ? {
            enableLineSelection: true,
            enableGutterUtility: true,
            onGutterUtilityClick: handleGutterUtilityClick
          }
        : {})
    }),
    [diffStyle, dark, pierreTheme, onLineAsk, handleGutterUtilityClick]
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
            editActive && edit !== undefined ? (
              <EditableFileDiff
                key={newName}
                fileDiff={metadata}
                options={fileDiffOptions}
                hostStyle={hostStyle}
                fileName={newName}
                canDiscardHunk={canDiscardHunk}
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
                options={fileDiffOptions}
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
 * One mounted edit session: the diff snapshot the editor is attached to.
 */
interface IEditSession {
  epoch: number;
  fileDiff: FileDiffMetadata;
  options: FileDiffOptions<IHunkActionAnnotation>;
  baseText: string;
}

/**
 * The new (additions) side of a textual diff rendered as an in-place editor,
 * autosaving to the working-tree file. The mounted diff is a snapshot of the
 * session's base text: whenever the host hands down a new diff and there are
 * no unsaved edits, the session recycles onto it — hunks and their discard
 * buttons track disk while caret, scroll and undo history carry over (the
 * editor's `persistState` cache reuses the text document, which owns the
 * undo stack, across recycles). Every autosave first checks the on-disk text
 * and pauses as a conflict if an external writer changed the file underneath
 * the session.
 */
function EditableFileDiff(props: {
  fileDiff: FileDiffMetadata;
  options: FileDiffOptions<IHunkActionAnnotation>;
  hostStyle: React.CSSProperties;
  fileName: string;
  canDiscardHunk: boolean;
  edit: IDiffEdit;
  trans: TranslationBundle;
}): React.ReactElement {
  const { options, hostStyle, canDiscardHunk, edit, trans } = props;

  // `persistState` requires a stable non-empty cacheKey on the attached
  // file; it keys the cached text document reused across recycles.
  const fileDiff = React.useMemo<FileDiffMetadata>(
    () => ({ ...props.fileDiff, cacheKey: `xtralab-edit:${props.fileName}` }),
    [props.fileDiff, props.fileName]
  );

  // Full text of the incoming diff's additions side (the library splits with
  // a newline-preserving pattern, so join('') is exact).
  const incomingBaseText = React.useMemo(
    () => fileDiff.additionLines.join(''),
    [fileDiff]
  );

  const [session, setSession] = React.useState<IEditSession>(() => ({
    epoch: 0,
    fileDiff,
    options,
    baseText: incomingBaseText
  }));
  const sessionRef = React.useRef(session);
  React.useEffect(() => {
    sessionRef.current = session;
  });

  // Editor text and last text confirmed on disk; refs so neither typing nor
  // save bookkeeping re-renders this widget.
  const latestTextRef = React.useRef(incomingBaseText);
  const savedTextRef = React.useRef(incomingBaseText);

  // Guards the single-flight save loop in `persist`.
  const savingRef = React.useRef(false);

  // The attached editor and its focus state, for hunk discards and for focus
  // restoration across session recycles (`persistState` restores caret and
  // scroll, but not DOM focus).
  const editorRef = React.useRef<Editor<IHunkActionAnnotation> | null>(null);
  const editorFocusedRef = React.useRef(false);
  const restoreFocusRef = React.useRef(false);

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

  // Set while a conflict notification is showing, so retries don't stack
  // toasts.
  const conflictToastRef = React.useRef<string | null>(null);
  // Lets one save bypass the disk check: set by the notification's
  // "Overwrite" action.
  const skipConflictGuardRef = React.useRef(false);
  // Set when the user discards their edits: nothing may be written anymore,
  // including the teardown flush.
  const abandonedRef = React.useRef(false);
  // `persist` and `notifyConflict` reference each other, so `persist` goes
  // through a ref.
  const notifyConflictRef = React.useRef<() => void>(() => undefined);

  // Single-flight save loop: drains to the latest text so writes never
  // overlap or land out of order. Each write first checks the disk and pauses
  // as a conflict if an external writer got there first; baselines only
  // advance on confirmed writes, so a failed save never reads back as saved.
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
            // The disk already holds the editor text: adopt it without
            // writing.
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
      // An unconsumed bypass must not exempt a later, unrelated save.
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

  // The editor reports every change synchronously (no built-in debounce), so
  // this component owns the autosave delay.
  const saveTimerRef = React.useRef<number | null>(null);

  const cancelPendingSave = React.useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  // Sticky notification: dismissing it silently would leave the session
  // paused with no explanation, and its actions must survive a closed tab
  // (they only touch refs and server state).
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

  // Recycle the session onto the latest diff/options. Adopting is only safe
  // when there are no unsaved edits (or the user just discarded theirs) —
  // the fresh mount's document comes from the incoming diff, so pending
  // edits would be lost. A skipped recycle retries after the next save.
  const [recycleTick, setRecycleTick] = React.useState(0);
  React.useEffect(() => {
    const current = sessionRef.current;
    if (current.fileDiff === fileDiff && current.options === options) {
      return;
    }
    const forced = abandonedRef.current;
    if (!forced && latestTextRef.current !== savedTextRef.current) {
      return;
    }
    abandonedRef.current = false;
    latestTextRef.current = incomingBaseText;
    savedTextRef.current = incomingBaseText;
    restoreFocusRef.current = editorFocusedRef.current;
    if (forced) {
      setSaveState('idle');
    }
    setSession(prev => ({
      epoch: prev.epoch + 1,
      fileDiff,
      options,
      baseText: incomingBaseText
    }));
  }, [fileDiff, options, incomingBaseText, recycleTick]);

  // Fires on every applied edit. `file.contents` lazily reads the library's
  // document; the captured text is what teardown flushes.
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
        // Back in sync with disk (an undo to the saved text). A save still
        // draining settles its own state; a skipped recycle can proceed now.
        cancelPendingSave();
        if (!savingRef.current) {
          setSaveState('idle');
        }
        setRecycleTick(tick => tick + 1);
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

  // Discard one change block through the live editor so it joins the undo
  // stack. The rendered blocks describe the session's base text; with
  // unsaved keystrokes the indexes may not match the document, so save first
  // and let the recycled session render accurate buttons instead.
  const discardBlock = React.useCallback(
    (payload: IHunkActionAnnotation) => {
      const editor = editorRef.current;
      const block = payload.block;
      if (editor === null || block === undefined) {
        return;
      }
      cancelPendingSave();
      const current = sessionRef.current;
      if (editor.getText() !== current.baseText) {
        void persist();
        return;
      }
      // Splice the block's old lines over its new lines. The line arrays
      // carry their own endings, so join('') is exact.
      const { additionLines, deletionLines } = current.fileDiff;
      const nextText =
        additionLines.slice(0, block.additionLineIndex).join('') +
        deletionLines
          .slice(
            block.deletionLineIndex,
            block.deletionLineIndex + block.deletions
          )
          .join('') +
        additionLines.slice(block.additionLineIndex + block.additions).join('');
      const textEdit = minimalTextEdit(current.baseText, nextText);
      if (textEdit !== null) {
        editor.applyEdits([textEdit]);
      }
      void persist();
    },
    [cancelPendingSave, persist]
  );

  // One button per contiguous change block (not per hunk): the parser merges
  // nearby blocks into a single hunk, and each block must stay individually
  // discardable while editing.
  const lineAnnotations = React.useMemo<
    DiffLineAnnotation<IHunkActionAnnotation>[]
  >(() => {
    if (!canDiscardHunk) {
      return [];
    }
    const annotations: DiffLineAnnotation<IHunkActionAnnotation>[] = [];
    session.fileDiff.hunks.forEach((hunk, hunkIndex) => {
      for (const content of hunk.hunkContent) {
        if (content.type !== 'change') {
          continue;
        }
        annotations.push({
          side: 'additions',
          // First line of the block on the new side (for a pure deletion,
          // the line right after the removal point).
          lineNumber: content.additionLineIndex + 1,
          metadata: {
            hunkIndex,
            block: {
              additions: content.additions,
              deletions: content.deletions,
              additionLineIndex: content.additionLineIndex,
              deletionLineIndex: content.deletionLineIndex
            }
          }
        });
      }
    });
    return annotations;
  }, [canDiscardHunk, session.fileDiff]);

  const renderAnnotation = React.useCallback(
    (
      annotation: DiffLineAnnotation<IHunkActionAnnotation>
    ): React.ReactNode => {
      if (annotation.metadata === undefined) {
        return null;
      }
      return (
        <HunkDiscardButton
          payload={annotation.metadata}
          onDiscard={discardBlock}
          trans={trans}
        />
      );
    },
    [discardBlock, trans]
  );

  const editorOptions = React.useMemo<EditorOptions<IHunkActionAnnotation>>(
    () => ({
      // Cache the text document per cacheKey so recycles keep the undo
      // history; the library restores caret and scroll from the same cache.
      persistState: true,
      onChange: handleEditorChange,
      onFocus: () => {
        editorFocusedRef.current = true;
      },
      onBlur: () => {
        editorFocusedRef.current = false;
      },
      onAttach: editor => {
        editorRef.current = editor;
        if (restoreFocusRef.current) {
          // Recycled session: caret and scroll come back from the state
          // cache, DOM focus does not.
          restoreFocusRef.current = false;
          editor.focus({ preventScroll: true });
          return;
        }
        // First mount: place the caret on the first visible editable line;
        // preventScroll keeps the reading position.
        editor.focus({ lineNumber: 'first-visible', preventScroll: true });
      }
    }),
    [handleEditorChange]
  );

  // Teardown flushes the last change instead of waiting out the autosave
  // delay; the library tears the editor itself down.
  React.useEffect(() => {
    return () => {
      cancelPendingSave();
      void persist();
    };
  }, [cancelPendingSave, persist]);

  // Let the "Saved" confirmation fade on its own.
  React.useEffect(() => {
    if (saveState !== 'saved') {
      return;
    }
    const timer = setTimeout(() => setSaveState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [saveState]);

  // Ctrl/Cmd+S persists immediately; `data-lm-suppress-shortcuts` below keeps
  // the keystroke from Lumino's save command and the browser dialog.
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

  // Keyed per session epoch: the library's in-place transition between
  // different diffs is unreliable, a fresh mount is not. Memoized so status
  // re-renders leave the library component untouched.
  const diffElement = React.useMemo(
    () => (
      <EditProvider createEditor={createEditor}>
        <FileDiff<IHunkActionAnnotation>
          key={session.epoch}
          fileDiff={session.fileDiff}
          edit={true}
          editorOptions={editorOptions}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          // This surface mounts straight into an edit session, so a sync
          // main-thread render beats a pooled paint the attach would redo.
          disableWorkerPool={true}
          style={hostStyle}
          options={session.options}
        />
      </EditProvider>
    ),
    [session, editorOptions, lineAnnotations, renderAnnotation, hostStyle]
  );

  return (
    <div
      className="jp-xtralab-DiffWidget-editRegion"
      data-lm-suppress-shortcuts="true"
      onKeyDownCapture={handleKeyDown}
    >
      <div className="jp-xtralab-DiffWidget-saveStatusBar">
        <EditSaveStatus state={saveState} trans={trans} />
      </div>
      {diffElement}
    </div>
  );
}

/**
 * Save-state indicator shown while editing; renders nothing when idle.
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
 * surface's `onFileDiffActiveChange`.
 */
export function DiffStyleControl(props: {
  diffStyle: DiffStyle;
  available: boolean;
  onChange: (style: DiffStyle) => void;
  trans: TranslationBundle;
}): React.ReactElement {
  const { diffStyle, available, onChange, trans } = props;
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
        title={trans.__('Split (side-by-side) view')}
        aria-label={trans.__('Split view')}
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
        title={trans.__('Unified (inline) view')}
        aria-label={trans.__('Unified view')}
        onClick={() => onChange('unified')}
      >
        <DiffUnifiedIcon />
      </button>
    </div>
  );
}
