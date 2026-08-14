import * as React from 'react';

import { IThemeManager } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { TranslationBundle } from '@jupyterlab/translation';
import { undoIcon } from '@jupyterlab/ui-components';
import { FileDiff } from '@pierre/diffs/react';
import {
  diffAcceptRejectHunk,
  parseDiffFromFile,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type SelectedLineRange
} from '@pierre/diffs';

import { ImageDiffView, imageDataType } from './imageDiff';
import {
  buildNotebookDiff,
  NotebookDiffView,
  type INotebookDiffResult
} from './notebookDiff';
import { resolveDiffTheme } from './diffTheme';

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

export function writeStoredDiffStyle(style: DiffStyle): void {
  try {
    window.localStorage.setItem(DIFF_STYLE_STORAGE_KEY, style);
  } catch {
    // Best-effort.
  }
}

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
    // See readStoredSplitRatio.
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
 * Annotation payload threaded back into `renderAnnotation`; carries the target hunk index.
 */
interface IHunkActionAnnotation {
  hunkIndex: number;
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
  enabled: boolean;
  save: (fullText: string) => Promise<void>;
  onAfterSave: () => void;
}

interface IDiffSurfaceProps {
  loading: boolean;
  error: string | null;
  isBinary: boolean;
  oldText: string;
  newText: string;
  newName: string;
  oldName?: string;
  dark: boolean;
  pierreTheme: boolean;
  rendermime: IRenderMimeRegistry | null;
  notebookViewMode: NotebookDiffViewMode;
  diffStyle: DiffStyle;
  onNotebookAvailabilityChange?: (available: boolean) => void;
  onFileDiffActiveChange?: (active: boolean) => void;
  onMetadataChange?: (info: { hunkCount: number | null }) => void;
  hunkDiscard?: IHunkDiscard;
  onLineAsk?: (range: SelectedLineRange, anchor: DOMRect | null) => void;
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
              trans={trans}
            />
          ) : showFileDiff && metadata !== null ? (
            <FileDiff<IHunkActionAnnotation>
              fileDiff={metadata}
              lineAnnotations={lineAnnotations}
              renderAnnotation={renderAnnotation}
              style={hostStyle}
              // JupyterLab's federation pipeline can't serve the worker bundle
              // at a resolvable URL, so the pool crashes; run on the main thread.
              disableWorkerPool={true}
              options={{
                diffStyle,
                disableFileHeader: true,
                theme: resolveDiffTheme(dark, pierreTheme),
                themeType: dark ? 'dark' : 'light',
                // Constant string lets the library skip its unsafeCSS re-render path.
                unsafeCSS: SPLIT_RESIZE_CSS,
                ...(onLineAsk !== undefined
                  ? {
                      enableLineSelection: true,
                      enableGutterUtility: true,
                      onGutterUtilityClick: handleGutterUtilityClick
                    }
                  : {})
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
 * Segmented Notebook/JSON selector. Hosts mount it into their own toolbar
 * and drive value/visibility from the state they pass to {@link DiffSurface}.
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
