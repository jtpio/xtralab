import * as React from 'react';

import { IThemeManager, MainAreaWidget } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import { ReactWidget, undoIcon } from '@jupyterlab/ui-components';
import { ISignal, Signal } from '@lumino/signaling';
import { FileDiff } from '@pierre/diffs/react';
import {
  diffAcceptRejectHunk,
  parseDiffFromFile,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata
} from '@pierre/diffs';

import { getTreeIcon } from '../fileBrowser/icons';
import { content } from './api';
import {
  buildNotebookDiff,
  NotebookDiffView,
  type INotebookDiffResult
} from './notebookDiff';
import { GitReference, IFileChange } from './tokens';

/**
 * The CSS class added to the diff main-area widget. The selectors that
 * style the embedded `@pierre/diffs` viewer hang off this class.
 */
export const DIFF_WIDGET_CSS_CLASS = 'jp-xtralab-DiffWidget';

/**
 * `localStorage` key for the user's last-chosen split ratio. Persisted so
 * the preference survives reloads — the library has no built-in way to
 * remember per-host UI state, and reopening every diff at 50/50 is
 * annoying once the user has dialed in a layout they like.
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
 * View modes available for `.ipynb` diffs. `notebook` is the cell-by-cell
 * rendered view; `json` falls back to the raw nbformat JSON file diff so
 * the user can inspect exactly which bytes changed (handy for nbformat
 * spelunking, seeing execution_count drift, etc.).
 */
type NotebookDiffViewMode = 'notebook' | 'json';

const NOTEBOOK_DIFF_VIEW_MODE_STORAGE_KEY =
  'xtralab:notebook-diff-view-mode';

function readStoredNotebookViewMode(): NotebookDiffViewMode {
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

function writeStoredNotebookViewMode(mode: NotebookDiffViewMode): void {
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
 * Build the deterministic widget id used for a diff against a particular
 * file/group pair. Reused across plugin and command code so reopening a
 * diff for the same file reveals the existing tab instead of opening a
 * second one.
 */
export function diffWidgetId(change: IFileChange): string {
  return `xtralab:diff:${change.group}:${change.path}`;
}

/**
 * Resolve the pair of git references whose `content` should appear on the
 * left and right side of the diff for a given file change. Mirrors VS
 * Code's source control diff: staged-side compares INDEX vs HEAD,
 * unstaged-side compares WORKING vs INDEX, and untracked files have no
 * "previous" version to compare against.
 */
export function resolveReferences(change: IFileChange): {
  oldRef: GitReference | null;
  newRef: GitReference | null;
} {
  if (change.status === 'untracked') {
    return { oldRef: null, newRef: { special: 'WORKING' } };
  }
  if (change.group === 'staged') {
    return { oldRef: { git: 'HEAD' }, newRef: { special: 'INDEX' } };
  }
  // Unstaged: WORKING vs INDEX. If the file isn't in the index yet (e.g.
  // a freshly-`git add`-ed file that has been modified again) the server
  // returns the HEAD blob for INDEX instead, which is still the right
  // baseline for the diff.
  return { oldRef: { special: 'INDEX' }, newRef: { special: 'WORKING' } };
}

export interface IGitDiffWidgetOptions {
  repoPath: string;
  change: IFileChange;
  themeManager: IThemeManager | null;
  contentsManager: Contents.IManager;
  /**
   * Rendermime registry used by the notebook diff path to render outputs
   * and markdown cells. May be `null` in stripped-down hosts; the notebook
   * diff falls back to a textual representation in that case.
   */
  rendermime: IRenderMimeRegistry | null;
  /**
   * Called after a hunk-level operation mutates the working tree, so the
   * surrounding plugin can refresh the changes panel.
   */
  onChanged: () => void;
  /**
   * Called when a post-discard reload finds no hunks left in the diff.
   * Wired by {@link createGitDiffWidget} to close the host
   * `MainAreaWidget` — there is nothing left to view, so the empty pane
   * would just be visual noise.
   */
  onEmpty?: () => void;
}

/**
 * Build a `MainAreaWidget`-hosted diff viewer for a single file change.
 * Wrapping the `ReactWidget` in a `MainAreaWidget` is what gives it the
 * usual document chrome — toolbar slot, focus tracker integration, and
 * spinner-while-loading hooks — and matches the pattern used for other
 * read-only main-area widgets in the JupyterLab ecosystem.
 */
export function createGitDiffWidget(
  options: IGitDiffWidgetOptions
): MainAreaWidget<DiffContentWidget> {
  // `widget` is captured by the `onEmpty` closure we pass into the content,
  // but doesn't exist yet at construction time — declare it up front so the
  // closure can read it once the widget is wired.
  let widget: MainAreaWidget<DiffContentWidget> | null = null;
  const content = new DiffContentWidget({
    ...options,
    onEmpty: () => {
      if (widget !== null && !widget.isDisposed) {
        widget.close();
      }
      options.onEmpty?.();
    }
  });
  widget = new MainAreaWidget<DiffContentWidget>({ content });
  widget.id = diffWidgetId(options.change);
  widget.title.label = formatTitle(options.change);
  widget.title.caption = options.change.path;
  widget.title.closable = true;
  widget.title.icon = getTreeIcon(options.change.path);
  widget.addClass(DIFF_WIDGET_CSS_CLASS);
  // Wire the notebook view-mode selector into the `MainAreaWidget` toolbar
  // — the proper home for document chrome controls. The toolbar starts
  // hidden and becomes visible once the React content reports a parsed
  // notebook diff via `setHasNotebookView`. Plain text / code diffs never
  // flip that flag, so their toolbar bar stays collapsed and the
  // resulting layout matches what other read-only main-area documents
  // look like in JupyterLab.
  widget.toolbar.addItem(
    'notebook-view-mode',
    new NotebookViewModeToolbarItem(content)
  );
  widget.toolbar.hide();
  const onHasNotebookViewChanged = (
    _sender: DiffContentWidget,
    value: boolean
  ): void => {
    if (widget === null || widget.isDisposed) {
      return;
    }
    if (value) {
      widget.toolbar.show();
    } else {
      widget.toolbar.hide();
    }
  };
  content.hasNotebookViewChanged.connect(onHasNotebookViewChanged);
  widget.disposed.connect(() => {
    content.hasNotebookViewChanged.disconnect(onHasNotebookViewChanged);
  });
  return widget;
}

/**
 * The actual React-rendered region of the diff viewer. Held in its own
 * `ReactWidget` so the surrounding `MainAreaWidget` can manage chrome
 * without React having to know about it.
 *
 * Owns the persistent UI state that the surrounding `MainAreaWidget`
 * toolbar needs to read and write (`notebookViewMode` and whether a
 * notebook view is even available for the current file). Storing this on
 * the widget — and exposing change signals — lets the toolbar widget and
 * the React content stay in sync without either side knowing about the
 * other.
 */
export class DiffContentWidget extends ReactWidget {
  constructor(options: IGitDiffWidgetOptions) {
    super();
    this._options = options;
    this._notebookViewMode = readStoredNotebookViewMode();
  }

  /** The change this widget renders, used by callers to identify the widget. */
  get change(): IFileChange {
    return this._options.change;
  }

  /** The user's current rendered-vs-JSON view choice for notebook diffs. */
  get notebookViewMode(): NotebookDiffViewMode {
    return this._notebookViewMode;
  }

  /** Update the notebook view mode and persist it across sessions. */
  setNotebookViewMode(mode: NotebookDiffViewMode): void {
    if (mode === this._notebookViewMode) {
      return;
    }
    this._notebookViewMode = mode;
    writeStoredNotebookViewMode(mode);
    this._notebookViewModeChanged.emit(mode);
  }

  /** Emits whenever {@link notebookViewMode} changes. */
  get notebookViewModeChanged(): ISignal<this, NotebookDiffViewMode> {
    return this._notebookViewModeChanged;
  }

  /**
   * Whether a rendered notebook view is currently available. Set by the
   * React content once it has parsed the diff; the toolbar reads this to
   * decide whether to show the view-mode selector.
   */
  get hasNotebookView(): boolean {
    return this._hasNotebookView;
  }

  setHasNotebookView(value: boolean): void {
    if (value === this._hasNotebookView) {
      return;
    }
    this._hasNotebookView = value;
    this._hasNotebookViewChanged.emit(value);
  }

  /** Emits whenever {@link hasNotebookView} changes. */
  get hasNotebookViewChanged(): ISignal<this, boolean> {
    return this._hasNotebookViewChanged;
  }

  protected render(): React.ReactElement {
    return <DiffViewer {...this._options} widget={this} />;
  }

  private _options: IGitDiffWidgetOptions;
  private _notebookViewMode: NotebookDiffViewMode;
  private _notebookViewModeChanged = new Signal<this, NotebookDiffViewMode>(
    this
  );
  private _hasNotebookView = false;
  private _hasNotebookViewChanged = new Signal<this, boolean>(this);
}

interface IDiffState {
  loading: boolean;
  /**
   * The pre-computed diff metadata for the current change. Owning the
   * metadata in our component lets us pass it to {@link FileDiff} *and*
   * thread the same instance through {@link diffAcceptRejectHunk} when the
   * user discards a hunk — so hunk indexes line up between what the user
   * clicked and what we mutate.
   */
  metadata: FileDiffMetadata | null;
  /**
   * Cell-by-cell notebook diff for `.ipynb` files. When non-null the
   * renderer uses a notebook-aware view instead of the line-oriented
   * file diff — kept distinct from {@link metadata} so a notebook whose
   * JSON we cannot parse can fall back to the file diff path without
   * losing the existing widget machinery.
   */
  notebookDiff: INotebookDiffResult | null;
  /**
   * Server-relative path of the file on disk. Computed from the repo path
   * + the file's git-root-relative path. We need it to write the file back
   * via the contents manager when discarding a hunk.
   */
  serverPath: string;
  isBinary: boolean;
  error: string | null;
}

/**
 * Detect notebook files by extension. We only look at the suffix so the
 * caller (the file-change tracker) doesn't need to plumb a content-type
 * field through; mistaking another `.ipynb`-named file for a notebook is
 * harmless because {@link buildNotebookDiff} validates the JSON shape and
 * we fall back to the file diff if parsing fails.
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
function isDarkTheme(themeManager: IThemeManager | null): boolean {
  if (themeManager !== null && themeManager.theme !== null) {
    return !themeManager.isLight(themeManager.theme);
  }
  return document.body.dataset.jpThemeLight === 'false';
}

function DiffViewer(
  props: IGitDiffWidgetOptions & { widget: DiffContentWidget }
): React.ReactElement {
  const {
    repoPath,
    change,
    themeManager,
    contentsManager,
    rendermime,
    onChanged,
    onEmpty,
    widget
  } = props;
  const [state, setState] = React.useState<IDiffState>({
    loading: true,
    metadata: null,
    notebookDiff: null,
    serverPath: '',
    isBinary: false,
    error: null
  });
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
  // Bumping `reloadKey` re-enters the fetch effect. Used after a successful
  // hunk discard, so the diff reflects the new working-tree contents
  // without the user having to close and reopen the tab.
  const [reloadKey, setReloadKey] = React.useState(0);
  // Mirror the widget's notebook view mode into local state so that
  // toolbar-driven changes re-render the diff. The widget owns the
  // canonical value (so the toolbar can read and write it without going
  // through React); the React copy is just a cache for rendering.
  const [notebookViewMode, setNotebookViewModeLocal] =
    React.useState<NotebookDiffViewMode>(() => widget.notebookViewMode);
  React.useEffect(() => {
    const handler = (
      _sender: DiffContentWidget,
      mode: NotebookDiffViewMode
    ): void => {
      setNotebookViewModeLocal(mode);
    };
    widget.notebookViewModeChanged.connect(handler);
    // Re-sync in case the widget changed before this effect ran.
    setNotebookViewModeLocal(widget.notebookViewMode);
    return () => {
      widget.notebookViewModeChanged.disconnect(handler);
    };
  }, [widget]);

  // Tell the host widget whether a rendered notebook view is currently
  // available. The toolbar item that lives in the `MainAreaWidget`
  // toolbar reads this flag to decide whether to show the
  // Notebook/JSON selector — and the toolbar bar itself stays hidden
  // when the file isn't a parseable notebook.
  React.useEffect(() => {
    widget.setHasNotebookView(state.notebookDiff !== null);
  }, [widget, state.notebookDiff]);

  // Auto-close after a discard that emptied the diff. Gated on `reloadKey > 0`
  // so a file that opens already-empty (uncommon but possible) is not closed
  // before the user has had a chance to look at it.
  React.useEffect(() => {
    if (
      !state.loading &&
      state.error === null &&
      !state.isBinary &&
      state.metadata !== null &&
      state.metadata.hunks.length === 0 &&
      reloadKey > 0
    ) {
      onEmpty?.();
    }
  }, [
    state.loading,
    state.error,
    state.isBinary,
    state.metadata,
    reloadKey,
    onEmpty
  ]);
  const [dark, setDark] = React.useState<boolean>(() =>
    isDarkTheme(themeManager)
  );

  // Track theme changes so the diff viewer recolors with the rest of
  // JupyterLab. We listen on `IThemeManager.themeChanged` when available
  // and fall back to a `<body>` attribute observer otherwise.
  React.useEffect(() => {
    if (themeManager !== null) {
      const handler = (): void => setDark(isDarkTheme(themeManager));
      themeManager.themeChanged.connect(handler);
      return () => {
        themeManager.themeChanged.disconnect(handler);
      };
    }
    const observer = new MutationObserver(() =>
      setDark(isDarkTheme(themeManager))
    );
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-jp-theme-light']
    });
    return () => {
      observer.disconnect();
    };
  }, [themeManager]);

  React.useEffect(() => {
    let cancelled = false;
    const { oldRef, newRef } = resolveReferences(change);
    const serverPath =
      repoPath.length > 0 ? PathExt.join(repoPath, change.path) : change.path;
    void (async () => {
      try {
        if (change.isBinary === true) {
          if (cancelled) {
            return;
          }
          setState({
            loading: false,
            metadata: null,
            notebookDiff: null,
            serverPath,
            isBinary: true,
            error: null
          });
          return;
        }
        const fetchOld =
          oldRef === null
            ? Promise.resolve({ content: '' })
            : content(repoPath, change.from ?? change.path, oldRef);
        const fetchNew =
          newRef === null
            ? Promise.resolve({ content: '' })
            : content(repoPath, change.path, newRef);
        const [oldRes, newRes] = await Promise.all([fetchOld, fetchNew]);
        if (cancelled) {
          return;
        }
        const oldText = oldRes.content ?? '';
        const newText = newRes.content ?? '';

        // For .ipynb files we precompute *both* the cell-by-cell
        // notebook diff and the raw JSON file diff up front. The user
        // toggles between them via the in-widget toolbar, so keeping
        // both around (instead of re-fetching on switch) makes the
        // toggle feel instant. If parsing fails, `notebookDiff` stays
        // null and we silently fall back to the file diff path.
        let notebookDiff: INotebookDiffResult | null = null;
        if (isNotebookPath(change.path)) {
          notebookDiff = buildNotebookDiff({ oldText, newText });
        }

        const oldFile: FileContents = {
          name: change.from ?? change.path,
          contents: oldText
        };
        const newFile: FileContents = {
          name: change.path,
          contents: newText
        };
        const metadata = parseDiffFromFile(oldFile, newFile);
        setState({
          loading: false,
          metadata,
          notebookDiff,
          serverPath,
          isBinary: false,
          error: null
        });
      } catch (err) {
        if (cancelled) {
          return;
        }
        setState({
          loading: false,
          metadata: null,
          notebookDiff: null,
          serverPath,
          isBinary: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath, change, reloadKey]);

  // Per-hunk discard buttons are only meaningful for unstaged modifications:
  // staged-vs-HEAD diffs would need an index manipulation we can't do
  // through the available endpoints, and untracked files have no previous
  // version to revert to. The annotation list collapses to empty in those
  // cases and the diff renders without action buttons.
  const canDiscardHunk =
    change.group === 'unstaged' && change.status !== 'untracked';

  const lineAnnotations = React.useMemo<
    DiffLineAnnotation<IHunkActionAnnotation>[]
  >(() => {
    if (!canDiscardHunk || state.metadata === null) {
      return [];
    }
    return state.metadata.hunks.map((hunk, hunkIndex) => ({
      side: 'additions',
      // The first line of each hunk in the new file. We anchor the button
      // there so it sits at the top of the hunk's body.
      lineNumber: hunk.additionStart,
      metadata: { hunkIndex }
    }));
  }, [canDiscardHunk, state.metadata]);

  const handleDiscardHunk = React.useCallback(
    async (hunkIndex: number) => {
      if (state.metadata === null) {
        return;
      }
      const updated = diffAcceptRejectHunk(state.metadata, hunkIndex, 'reject');
      // `additionLines` after a 'reject' contains the full new file with
      // the hunk reverted back to the old content. The library splits
      // file contents with `/(?<=\n)/` (a lookbehind that keeps the
      // trailing `\n` on each line), so the entries already carry their
      // own line endings — joining with `''` rebuilds the original text
      // verbatim, while joining with `'\n'` would double every newline.
      const text = updated.additionLines.join('');
      try {
        await contentsManager.save(state.serverPath, {
          type: 'file',
          format: 'text',
          content: text
        });
        onChanged();
        setReloadKey(key => key + 1);
      } catch (err) {
        console.error('xtralab: failed to discard hunk', err);
      }
    },
    [contentsManager, onChanged, state.metadata, state.serverPath]
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

  if (state.loading) {
    return (
      <div className="jp-xtralab-DiffWidget-status">Loading diff…</div>
    );
  }
  if (state.error !== null) {
    return (
      <div className="jp-xtralab-DiffWidget-status" data-error="true">
        {state.error}
      </div>
    );
  }
  if (state.isBinary) {
    return (
      <div className="jp-xtralab-DiffWidget-status">
        Binary file — diff not supported.
      </div>
    );
  }
  // Decide which view to render. The notebook view requires a successful
  // nbformat parse; if that failed, the toolbar is hidden and we only
  // show the raw JSON file diff. The toolbar itself is sticky at the top
  // of the content area, sitting above the scroll viewport.
  const hasNotebookView = state.notebookDiff !== null;
  const showNotebookView = hasNotebookView && notebookViewMode === 'notebook';
  const showFileDiff = !showNotebookView && state.metadata !== null;

  if (!showNotebookView && !showFileDiff) {
    return (
      <div className="jp-xtralab-DiffWidget-status">
        No content to diff.
      </div>
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
          {showNotebookView && state.notebookDiff !== null ? (
            <NotebookDiffView
              diff={state.notebookDiff}
              dark={dark}
              rendermime={rendermime}
            />
          ) : showFileDiff && state.metadata !== null ? (
            <FileDiff<IHunkActionAnnotation>
              fileDiff={state.metadata}
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
                diffStyle: 'split',
                // Drop the file header — the tab title already shows the
                // file name and the panel header carries the change
                // context.
                disableFileHeader: true,
                theme: dark ? 'pierre-dark' : 'pierre-light',
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
        {showFileDiff ? (
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
 * Segmented Notebook/JSON selector mounted into the `MainAreaWidget`
 * toolbar for `.ipynb` diffs. The selector reads from and writes to the
 * `DiffContentWidget` so React state changes (via the diff content) and
 * toolbar interactions stay in sync without either side knowing about
 * the other. The host toolbar widget's visibility is toggled by
 * {@link createGitDiffWidget} based on the same `hasNotebookView`
 * signal, so this control is always meaningful when it appears.
 */
class NotebookViewModeToolbarItem extends ReactWidget {
  constructor(content: DiffContentWidget) {
    super();
    this._content = content;
    this.addClass('jp-xtralab-DiffWidget-viewModeToolbarItem');
  }

  protected render(): React.ReactElement {
    return <NotebookViewModeControl content={this._content} />;
  }

  private _content: DiffContentWidget;
}

function NotebookViewModeControl(props: {
  content: DiffContentWidget;
}): React.ReactElement {
  const { content } = props;
  const [mode, setMode] = React.useState<NotebookDiffViewMode>(
    () => content.notebookViewMode
  );
  React.useEffect(() => {
    const handler = (
      _sender: DiffContentWidget,
      next: NotebookDiffViewMode
    ): void => {
      setMode(next);
    };
    content.notebookViewModeChanged.connect(handler);
    setMode(content.notebookViewMode);
    return () => {
      content.notebookViewModeChanged.disconnect(handler);
    };
  }, [content]);
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
        onClick={() => content.setNotebookViewMode('notebook')}
      >
        Notebook
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'json'}
        data-active={mode === 'json'}
        className="jp-xtralab-DiffWidget-segmentedButton"
        onClick={() => content.setNotebookViewMode('json')}
      >
        JSON
      </button>
    </div>
  );
}

function formatTitle(change: IFileChange): string {
  const name = change.path.split('/').pop() ?? change.path;
  const groupLabel = change.group === 'staged' ? 'Staged' : 'Working';
  return `${name} (${groupLabel})`;
}
