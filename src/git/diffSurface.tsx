import * as React from 'react';

import { IThemeManager, Notification } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { TranslationBundle } from '@jupyterlab/translation';
import { undoIcon } from '@jupyterlab/ui-components';
import { EditProvider, FileDiff } from '@pierre/diffs/react';
import {
  Editor,
  type EditorOptions,
  type EditorFactory,
  type EditorChangeEvent,
  type FileDiffEditCompleteEvent,
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

export const DIFF_WIDGET_CSS_CLASS = 'jp-xtralab-DiffWidget';

const SPLIT_RATIO_STORAGE_KEY = 'xtralab:diff-split-ratio';

const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;
const DEFAULT_SPLIT_RATIO = 0.5;

/**
 * Injected via the `unsafeCSS` option into the shadow root's `@layer
 * unsafe`, beating the library's base rule that hardcodes `1fr 1fr`. Reads
 * `--xtralab-split-cols` set on the host — custom properties cross the
 * shadow boundary, so resizing needs no re-render.
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
    // localStorage can throw in privacy mode or sandboxed contexts.
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

export type DiffStyle = 'split' | 'unified';

const DIFF_STYLE_STORAGE_KEY = 'xtralab:diff-style';

/**
 * Read the persisted diff style, defaulting to `'split'`.
 */
export function readStoredDiffStyle(): DiffStyle {
  try {
    const raw = window.localStorage.getItem(DIFF_STYLE_STORAGE_KEY);
    if (raw === 'split' || raw === 'unified') {
      return raw;
    }
  } catch {
    // See readStoredSplitRatio.
  }
  return 'split';
}

/**
 * Persist the diff style to local storage (best-effort).
 */
export function writeStoredDiffStyle(style: DiffStyle): void {
  try {
    window.localStorage.setItem(DIFF_STYLE_STORAGE_KEY, style);
  } catch {
    // Best-effort.
  }
}

export type NotebookDiffViewMode = 'notebook' | 'json';

const NOTEBOOK_DIFF_VIEW_MODE_STORAGE_KEY = 'xtralab:notebook-diff-view-mode';

/**
 * Read the persisted notebook view mode, defaulting to `'notebook'`.
 */
export function readStoredNotebookViewMode(): NotebookDiffViewMode {
  try {
    const raw = window.localStorage.getItem(
      NOTEBOOK_DIFF_VIEW_MODE_STORAGE_KEY
    );
    if (raw === 'json' || raw === 'notebook') {
      return raw;
    }
  } catch {
    // See readStoredSplitRatio.
  }
  return 'notebook';
}

/**
 * Persist the notebook view mode to local storage (best-effort).
 */
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
  /**
   * The index of the hunk the action targets.
   */
  hunkIndex: number;
  block?: {
    deletionLineIndex: number;
    deletions: number;
  };
}

/**
 * Extension-only check; a false positive is harmless because
 * {@link buildNotebookDiff} validates the JSON and the file diff is the fallback.
 */
function isNotebookPath(path: string): boolean {
  return path.toLowerCase().endsWith('.ipynb');
}

/**
 * Dark-theme check via `IThemeManager`, falling back to the
 * `data-jp-theme-light` body attribute for hosts without the token.
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
 * Per-hunk discard wiring: discarding rebuilds the full file text and the
 * host owns the write via `save`, then refreshes in `onAfterSave`.
 */
interface IHunkDiscard {
  /**
   * Whether hunk discarding is available.
   */
  enabled: boolean;
  /**
   * Persist the full post-discard file text.
   */
  save: (fullText: string) => Promise<void>;
  /**
   * Called after a successful save so the host can refresh the diff.
   */
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
  /** Server-relative identity, including the repository path. */
  filePath: string;
  /** Keep selection requests in sync without feeding the draft back. */
  onDraftChange?: (fullText: string) => void;
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
  onConflictDiscard?: () => Promise<void>;
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
const createEditor: EditorFactory<IHunkActionAnnotation, undefined> = (
  type,
  options,
  editStateKey
) => new Editor(type, options, editStateKey);

/**
 * Smallest single edit turning `before` into `after` (null when equal), with
 * boundaries that preserve surrogate pairs and complete line endings.
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
  const splitsPair = (text: string, offset: number): boolean => {
    const previous = text.charCodeAt(offset - 1);
    const next = text.charCodeAt(offset);
    return (
      (previous === 13 && next === 10) ||
      (previous >= 0xd800 &&
        previous <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff)
    );
  };
  // Pierre normalizes edit ranges to complete code points and excludes line
  // endings from character offsets. Include both halves in the replacement.
  while (splitsPair(before, start) || splitsPair(after, start)) {
    start--;
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
  while (splitsPair(before, beforeEnd) || splitsPair(after, afterEnd)) {
    beforeEnd++;
    afterEnd++;
  }
  return {
    range: {
      start: positionAtOffset(before, start),
      end: positionAtOffset(before, beforeEnd)
    },
    newText: after.slice(start, afterEnd)
  };
}

/** Convert a safe UTF-16 offset, recognizing LF, CRLF and CR line endings. */
function positionAtOffset(text: string, offset: number): Position {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    const character = text.charCodeAt(i);
    if (character === 13 || character === 10) {
      if (character === 13 && text.charCodeAt(i + 1) === 10) {
        i++;
      }
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
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

/**
 * The props for the {@link DiffSurface} component.
 */
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
   * New-side path; drives notebook detection and the highlighting filename.
   */
  newName: string;
  /**
   * Old-side path; differs from {@link newName} only for renames.
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
   * Used by the notebook view; `null` in stripped-down hosts, which forces a textual fallback.
   */
  rendermime: IRenderMimeRegistry | null;
  /**
   * Rendered-vs-JSON choice for notebook diffs (host-controlled).
   */
  notebookViewMode: NotebookDiffViewMode;
  /**
   * Split vs unified layout for the textual file diff (host-controlled).
   */
  diffStyle: DiffStyle;
  /**
   * Fires when rendered-notebook availability changes so the host can toggle its Notebook/JSON control.
   */
  onNotebookAvailabilityChange?: (available: boolean) => void;
  /**
   * Fires when the textual file diff becomes (in)active — the only view the split/unified choice affects.
   */
  onFileDiffActiveChange?: (active: boolean) => void;
  /**
   * Fires after each diff computation with the hunk count (`null` when no
   * textual diff); hosts use it to auto-close emptied diffs.
   */
  onMetadataChange?: (info: { hunkCount: number | null }) => void;
  /**
   * Optional per-hunk discard wiring; omit for a read-only diff.
   */
  hunkDiscard?: IHunkDiscard;
  /**
   * Enables line selection and the gutter "+" button; called with the
   * selected range and the button's viewport rect (`null` when unmeasurable).
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

  // For raster images the host passes both sides as base64 in oldText/newText.
  const imageType = React.useMemo(() => imageDataType(newName), [newName]);

  // Owning the metadata here keeps hunk indexes aligned between FileDiff
  // and diffAcceptRejectHunk on discard.
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

  const notebookDiff = React.useMemo<INotebookDiffResult | null>(() => {
    if (!hasContent || imageType !== null || !isNotebookPath(newName)) {
      return null;
    }
    return buildNotebookDiff({ oldText, newText });
  }, [hasContent, imageType, oldText, newText, newName]);

  React.useEffect(() => {
    onNotebookAvailabilityChange?.(notebookDiff !== null);
  }, [onNotebookAvailabilityChange, notebookDiff]);

  React.useEffect(() => {
    onMetadataChange?.({
      hunkCount: metadata !== null ? metadata.hunks.length : null
    });
  }, [onMetadataChange, metadata]);

  // Computed before the early returns so the hooks below can depend on
  // them without breaking the rules of hooks.
  const hasNotebookView = notebookDiff !== null;
  const showNotebookView = hasNotebookView && notebookViewMode === 'notebook';
  const showFileDiff = !showNotebookView && metadata !== null;

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
  // Drag listeners read the live ratio from a ref to avoid stale captures.
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
      // additionLines holds the full new file with the hunk reverted; lines keep
      // their trailing `\n` (lookbehind split), so join('') rebuilds it verbatim.
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
      // Anchor to the just-clicked gutter "+" button inside the library's open shadow root.
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

  // Shared by the read-only and editable renders; a stable identity lets the
  // library skip its option-equality check on unrelated re-renders. Line
  // selection + the ask-agent gutter button ride along when the host wired a
  // handler, in both renders.
  const fileDiffOptions = React.useMemo<
    FileDiffOptions<IHunkActionAnnotation, undefined>
  >(
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
                key={edit.filePath}
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

function editAnnotations(
  diff: FileDiffMetadata
): DiffLineAnnotation<IHunkActionAnnotation>[] {
  return diff.hunks.flatMap((hunk, hunkIndex) =>
    hunk.hunkContent.flatMap(content =>
      content.type === 'change'
        ? [
            {
              // A deletion at EOF has no following additions line to anchor to.
              side:
                content.additions === 0
                  ? ('deletions' as const)
                  : ('additions' as const),
              lineNumber:
                (content.additions === 0
                  ? content.deletionLineIndex
                  : content.additionLineIndex) + 1,
              metadata: {
                hunkIndex,
                block: {
                  deletionLineIndex: content.deletionLineIndex,
                  deletions: content.deletions
                }
              }
            }
          ]
        : []
    )
  );
}

/**
 * Pierre owns the active draft and undo history. Disk saves and authoritative
 * external replacements are separate from that editing session.
 */
function EditableFileDiff(props: {
  fileDiff: FileDiffMetadata;
  options: FileDiffOptions<IHunkActionAnnotation, undefined>;
  hostStyle: React.CSSProperties;
  fileName: string;
  canDiscardHunk: boolean;
  edit: IDiffEdit;
  trans: TranslationBundle;
}): React.ReactElement {
  const { fileDiff, options, hostStyle, canDiscardHunk, edit, trans } = props;
  const [externalDiff, setExternalDiff] = React.useState(fileDiff);
  const externalDiffRef = React.useRef(externalDiff);
  const latestTextRef = React.useRef(fileDiff.additionLines.join(''));
  const savedTextRef = React.useRef(latestTextRef.current);
  const editorRef = React.useRef<Editor<
    'file-diff',
    IHunkActionAnnotation
  > | null>(null);
  const savingRef = React.useRef(false);
  const abandonedRef = React.useRef(false);
  const reloadingRef = React.useRef(false);
  const [reconcileRevision, reconcile] = React.useReducer(
    value => value + 1,
    0
  );
  const mountedRef = React.useRef(true);
  const editRef = React.useRef(edit);
  editRef.current = edit;
  const [saveState, setSaveState] = React.useState<EditSaveState>('idle');
  const conflictToastRef = React.useRef<string | null>(null);
  const overwriteRef = React.useRef(false);
  const saveTimerRef = React.useRef<number | null>(null);
  const [lineAnnotations, setLineAnnotations] = React.useState(() =>
    editAnnotations(fileDiff)
  );

  const cancelPendingSave = React.useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const currentDiff = React.useCallback(() => {
    const base = externalDiffRef.current;
    return parseDiffFromFile(
      {
        name: base.prevName ?? base.name,
        contents: base.deletionLines.join('')
      },
      { name: base.name, contents: latestTextRef.current }
    );
  }, []);

  const refreshActions = React.useCallback(() => {
    if (mountedRef.current) {
      // Rebuild action definitions at a save boundary, including newly created
      // change blocks. Never echo the editor's remapped annotations or draft.
      setLineAnnotations(editAnnotations(currentDiff()));
    }
  }, [currentDiff]);

  const notifyConflictRef = React.useRef<() => void>(() => undefined);
  const persist = React.useCallback(async () => {
    if (
      savingRef.current ||
      abandonedRef.current ||
      (conflictToastRef.current !== null && !overwriteRef.current)
    ) {
      return;
    }
    savingRef.current = true;
    try {
      let didSave = false;
      while (
        !abandonedRef.current &&
        (overwriteRef.current || latestTextRef.current !== savedTextRef.current)
      ) {
        const text = latestTextRef.current;
        setSaveState('saving');
        if (overwriteRef.current) {
          overwriteRef.current = false;
        } else {
          let diskText: string;
          try {
            diskText = await editRef.current.readDiskText();
          } catch (err) {
            setSaveState('error');
            Notification.error(
              trans.__(
                'Failed to read %1 before saving: %2',
                props.fileName,
                err instanceof Error ? err.message : String(err)
              )
            );
            return;
          }
          if (abandonedRef.current) {
            return;
          }
          if (diskText === text) {
            savedTextRef.current = text;
            editRef.current.onSaved?.(text);
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
          await editRef.current.save(text);
        } catch {
          // The host also reports failures after the tab has closed.
          setSaveState('error');
          return;
        }
        savedTextRef.current = text;
        editRef.current.onSaved?.(text);
        didSave = true;
      }
      if (didSave && !abandonedRef.current) {
        refreshActions();
        setSaveState('saved');
      }
    } finally {
      overwriteRef.current = false;
      savingRef.current = false;
    }
  }, [props.fileName, refreshActions, trans]);

  notifyConflictRef.current = () => {
    if (conflictToastRef.current !== null) {
      return;
    }
    conflictToastRef.current = Notification.warning(
      trans.__('%1 changed on disk while you were editing it.', props.fileName),
      {
        autoClose: false,
        actions: [
          {
            label: trans.__('Overwrite'),
            caption: trans.__('Replace the file on disk with your edited text'),
            displayType: 'warn',
            callback: () => {
              conflictToastRef.current = null;
              overwriteRef.current = true;
              void persist();
            }
          },
          {
            label: trans.__('Discard my edits'),
            caption: trans.__('Keep the file on disk and reload the diff'),
            callback: async () => {
              conflictToastRef.current = null;
              abandonedRef.current = true;
              reloadingRef.current = true;
              cancelPendingSave();
              try {
                await editRef.current.onConflictDiscard?.();
              } finally {
                reloadingRef.current = false;
                if (mountedRef.current) {
                  reconcile();
                }
              }
            }
          }
        ]
      }
    );
  };

  React.useEffect(() => {
    if (
      reloadingRef.current ||
      (!abandonedRef.current &&
        (savingRef.current || latestTextRef.current !== savedTextRef.current))
    ) {
      return;
    }
    const incoming = fileDiff.additionLines.join('');
    const sameReference =
      fileDiff.deletionLines.join('') ===
      externalDiffRef.current.deletionLines.join('');
    // Autosave echoes must not replace the active draft or its annotations.
    if (
      !abandonedRef.current &&
      sameReference &&
      incoming === savedTextRef.current
    ) {
      return;
    }
    if (conflictToastRef.current !== null) {
      // Undoing all local edits lets an already loaded external version win.
      Notification.dismiss(conflictToastRef.current);
      conflictToastRef.current = null;
    }
    abandonedRef.current = false;
    latestTextRef.current = savedTextRef.current = incoming;
    externalDiffRef.current = fileDiff;
    setExternalDiff(fileDiff);
    setLineAnnotations(editAnnotations(fileDiff));
    setSaveState('idle');
    editRef.current.onDraftChange?.(incoming);
  }, [fileDiff, saveState, reconcileRevision]);

  const handleEditChange = React.useCallback(
    (
      event: EditorChangeEvent<'file-diff', IHunkActionAnnotation, undefined>
    ) => {
      latestTextRef.current = event.file.contents;
      editRef.current.onDraftChange?.(latestTextRef.current);
      cancelPendingSave();
      if (latestTextRef.current === savedTextRef.current) {
        if (!savingRef.current && conflictToastRef.current === null) {
          setSaveState('idle');
        }
        reconcile();
        return;
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void persist();
      }, EDIT_AUTOSAVE_DELAY_MS);
    },
    [cancelPendingSave, persist]
  );

  const handleEditComplete = React.useCallback(
    (event: FileDiffEditCompleteEvent<IHunkActionAnnotation, undefined>) => {
      cancelPendingSave();
      if (abandonedRef.current) {
        return 'reject' as const;
      }
      latestTextRef.current = event.newFile?.contents ?? '';
      void persist();
      // Acceptance settles the component. Server persistence remains async.
      return 'accept' as const;
    },
    [cancelPendingSave, persist]
  );

  const discardBlock = React.useCallback(
    (payload: IHunkActionAnnotation) => {
      const editor = editorRef.current;
      if (editor === null || payload.block === undefined) {
        return;
      }
      const diff = currentDiff();
      const { deletionLineIndex: start, deletions } = payload.block;
      for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
        const changeIndex = diff.hunks[hunkIndex].hunkContent.findIndex(
          content => {
            if (content.type !== 'change') {
              return false;
            }
            const currentStart = content.deletionLineIndex;
            // Edits may shrink a block before its annotations are refreshed.
            // Match surviving old-side lines, or the exact anchor of an insertion.
            return deletions === 0 || content.deletions === 0
              ? currentStart === start
              : currentStart < start + deletions &&
                  currentStart + content.deletions > start;
          }
        );
        if (changeIndex < 0) {
          continue;
        }
        const reverted = diffAcceptRejectHunk(diff, hunkIndex, {
          type: 'reject',
          changeIndex
        });
        const change = minimalTextEdit(
          editor.getText(),
          reverted.additionLines.join('')
        );
        if (change !== null) {
          editor.applyEdits([change]);
        }
        cancelPendingSave();
        refreshActions();
        void persist();
        return;
      }
      refreshActions();
    },
    [cancelPendingSave, currentDiff, persist, refreshActions]
  );

  const renderAnnotation = React.useCallback(
    (annotation: DiffLineAnnotation<IHunkActionAnnotation>) => (
      <HunkDiscardButton
        payload={annotation.metadata}
        onDiscard={discardBlock}
        trans={trans}
      />
    ),
    [discardBlock, trans]
  );
  const editorOptions = React.useMemo<
    EditorOptions<'file-diff', IHunkActionAnnotation, undefined>
  >(
    () => ({
      onAttach: editor => {
        editorRef.current = editor;
        editor.focus({ lineNumber: 'first-visible', preventScroll: true });
      }
    }),
    []
  );

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingSave();
    };
  }, [cancelPendingSave]);
  React.useEffect(() => {
    if (saveState !== 'saved') {
      return;
    }
    const timer = setTimeout(() => setSaveState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [saveState]);

  return (
    <div
      className="jp-xtralab-DiffWidget-editRegion"
      data-lm-suppress-shortcuts="true"
      onKeyDownCapture={event => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 's'
        ) {
          event.preventDefault();
          event.stopPropagation();
          cancelPendingSave();
          void persist();
        }
      }}
    >
      <div className="jp-xtralab-DiffWidget-saveStatusBar">
        <EditSaveStatus state={saveState} trans={trans} />
      </div>
      <EditProvider createEditor={createEditor}>
        <FileDiff<IHunkActionAnnotation>
          fileDiff={externalDiff}
          edit
          editorOptions={editorOptions}
          onEditChange={handleEditChange}
          onEditComplete={handleEditComplete}
          lineAnnotations={canDiscardHunk ? lineAnnotations : []}
          renderAnnotation={renderAnnotation}
          disableWorkerPool
          style={hostStyle}
          options={options}
        />
      </EditProvider>
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
 * Split / unified glyphs inlined from the `@pierre/diffs` icon sprite so
 * the toggle matches the library's docs site without the sprite sheet;
 * `currentColor` lets the button styling drive the fill.
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
 * Segmented Split/Unified selector; mirrors {@link NotebookViewModeControl}.
 * `available` mirrors the surface's `onFileDiffActiveChange`.
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
