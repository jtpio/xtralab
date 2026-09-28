import * as React from 'react';

import { IThemeManager } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { TranslationBundle } from '@jupyterlab/translation';
import { undoIcon } from '@jupyterlab/ui-components';
import { FileDiff } from '@pierre/diffs/react';
import { IconDiffSplit, IconDiffUnified, IconWordWrap } from '@pierre/icons';
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
import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  type DiffStyle,
  type DiffStyleControlMode,
  type ImageDiffViewMode,
  type NotebookDiffViewMode
} from './diffPreferences';
import { DIFF_SCROLLBAR_CSS, resolveDiffTheme } from './diffTheme';

export const DIFF_WIDGET_CSS_CLASS = 'jp-xtralab-DiffWidget';

/**
 * Injected via the `unsafeCSS` option into the shadow root's `@layer
 * unsafe`, beating the library's base rule that hardcodes `1fr 1fr`. Reads
 * `--xtralab-split-cols` set on the host — custom properties cross the
 * shadow boundary, so resizing needs no re-render.
 */
const SPLIT_RESIZE_CSS = `pre[data-diff-type="split"][data-overflow="scroll"] {
  grid-template-columns: var(--xtralab-split-cols, 1fr 1fr);
}`;

const DIFF_SURFACE_CSS = `${SPLIT_RESIZE_CSS}\n${DIFF_SCROLLBAR_CSS}`;

/**
 * Annotation payload threaded back into `renderAnnotation`; carries the target hunk index.
 */
interface IHunkActionAnnotation {
  /**
   * The index of the hunk the action targets.
   */
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
   * Whether long lines wrap instead of scrolling horizontally (host-controlled).
   */
  lineWrap: boolean;
  /**
   * Left pane width in split view, as a fraction of the diff width (host-controlled).
   */
  splitRatio: number;
  /**
   * Called when the user finishes resizing the split panes.
   */
  onSplitRatioChange: (ratio: number) => void;
  /**
   * 2-up, swipe or onion view for image diffs (host-controlled).
   */
  imageViewMode: ImageDiffViewMode;
  /**
   * Called when the user picks another image view mode.
   */
  onImageViewModeChange: (mode: ImageDiffViewMode) => void;
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
    lineWrap,
    splitRatio,
    onSplitRatioChange,
    imageViewMode,
    onImageViewModeChange,
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

  // Local while dragging; the host hears the ratio when a drag ends.
  const [leftRatio, setLeftRatio] = React.useState<number>(splitRatio);
  React.useEffect(() => {
    setLeftRatio(splitRatio);
  }, [splitRatio]);
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
        onSplitRatioChange(leftRatioRef.current);
      };
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerEnd);
      handle.addEventListener('pointercancel', onPointerEnd);
    },
    [onSplitRatioChange]
  );

  const handleResizerDoubleClick = React.useCallback(() => {
    setLeftRatio(DEFAULT_SPLIT_RATIO);
    onSplitRatioChange(DEFAULT_SPLIT_RATIO);
  }, [onSplitRatioChange]);

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
      onSplitRatioChange(clamped);
    },
    [onSplitRatioChange]
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
          mode={imageViewMode}
          onModeChange={onImageViewModeChange}
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
  // The wrapped split grid sizes its gutter tracks to their content, so a
  // percentage split cannot line up with the handle.
  const showResizer = showFileDiff && diffStyle === 'split' && !lineWrap;
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
                overflow: lineWrap ? 'wrap' : 'scroll',
                disableFileHeader: true,
                theme: resolveDiffTheme(dark, pierreTheme),
                themeType: dark ? 'dark' : 'light',
                // Constant string lets the library skip its unsafeCSS re-render path.
                unsafeCSS: DIFF_SURFACE_CSS,
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
        {showResizer ? (
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
 * Split/Unified selector: two segmented buttons, or with `control: 'toggle'`
 * one button that shows the layout it switches to.
 * `available` mirrors the surface's `onFileDiffActiveChange`.
 */
export function DiffStyleControl(props: {
  diffStyle: DiffStyle;
  control: DiffStyleControlMode;
  available: boolean;
  onChange: (style: DiffStyle) => void;
  trans: TranslationBundle;
}): React.ReactElement {
  const { diffStyle, control, available, onChange, trans } = props;
  if (!available) {
    return <></>;
  }
  if (control === 'toggle') {
    const next: DiffStyle = diffStyle === 'split' ? 'unified' : 'split';
    const label =
      next === 'split'
        ? trans.__('Switch to split view')
        : trans.__('Switch to unified view');
    return (
      <div className="jp-xtralab-DiffWidget-segmented">
        <button
          type="button"
          className="jp-xtralab-DiffWidget-segmentedButton jp-xtralab-DiffWidget-segmentedButton-icon"
          title={label}
          aria-label={label}
          onClick={() => onChange(next)}
        >
          {next === 'split' ? <IconDiffSplit /> : <IconDiffUnified />}
        </button>
      </div>
    );
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
        <IconDiffSplit />
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
        <IconDiffUnified />
      </button>
    </div>
  );
}

/**
 * Line-wrap toggle styled as a one-button segmented control.
 * `available` mirrors the surface's `onFileDiffActiveChange`.
 */
export function LineWrapControl(props: {
  lineWrap: boolean;
  available: boolean;
  onChange: (wrap: boolean) => void;
  trans: TranslationBundle;
}): React.ReactElement {
  const { lineWrap, available, onChange, trans } = props;
  if (!available) {
    return <></>;
  }
  return (
    <div className="jp-xtralab-DiffWidget-segmented">
      <button
        type="button"
        aria-pressed={lineWrap}
        data-active={lineWrap}
        className="jp-xtralab-DiffWidget-segmentedButton jp-xtralab-DiffWidget-segmentedButton-icon"
        title={trans.__('Wrap long lines')}
        aria-label={trans.__('Wrap lines')}
        onClick={() => onChange(!lineWrap)}
      >
        <IconWordWrap />
      </button>
    </div>
  );
}
