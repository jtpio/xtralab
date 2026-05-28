import * as React from 'react';

import { IThemeManager, MainAreaWidget } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import {
  ReactWidget,
  ToolbarButton,
  launchIcon
} from '@jupyterlab/ui-components';
import { ISignal, Signal } from '@lumino/signaling';

import { getTreeIcon } from '../fileBrowser/icons';
import { content } from './api';
import { imageDataType } from './imageDiff';
import {
  DIFF_WIDGET_CSS_CLASS,
  DiffStyleControl,
  DiffSurface,
  NotebookViewModeControl,
  isDarkTheme,
  readStoredDiffStyle,
  readStoredNotebookViewMode,
  writeStoredDiffStyle,
  writeStoredNotebookViewMode,
  type DiffStyle,
  type NotebookDiffViewMode
} from './diffSurface';
import { GitReference, IFileChange } from './tokens';

export { DIFF_WIDGET_CSS_CLASS };

export const PREVIEW_DIFF_WIDGET_ID = 'xtralab:diff:preview';

export function pinnedDiffWidgetId(change: IFileChange): string {
  return `xtralab:diff:pinned:${change.group}:${change.path}`;
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

function toServerPath(repoPath: string, filePath: string): string {
  return repoPath.length > 0 ? PathExt.join(repoPath, filePath) : filePath;
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
  onPinned?: (widget: MainAreaWidget<DiffContentWidget>) => void;
  pinned?: boolean;
}

/**
 * Build a `MainAreaWidget`-hosted diff viewer for a single file change.
 * Wrapping the `ReactWidget` in a `MainAreaWidget` is what gives it the
 * usual document chrome — toolbar slot, focus tracker integration, and
 * spinner-while-loading hooks — and matches the pattern used for other
 * read-only main-area widgets in the JupyterLab ecosystem.
 *
 * This is the launcher dashboard's own diff path
 * (`xtralab:git:open-diff`), kept independent of `jupyterlab-git`. The
 * actual diff rendering is delegated to the shared {@link DiffSurface};
 * `jupyterlab-git`'s panel reaches the same surface through the providers
 * registered in `diffProvider.tsx`.
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
  widget.id =
    options.pinned === true
      ? pinnedDiffWidgetId(options.change)
      : PREVIEW_DIFF_WIDGET_ID;
  widget.title.label = formatTitle(options.change);
  widget.title.caption = options.change.path;
  widget.title.closable = true;
  widget.title.icon = getTreeIcon(options.change.path);
  widget.title.className = options.pinned === true ? '' : 'jp-mod-preview';
  const onPinned = options.onPinned ?? (() => {});
  widget.addClass(DIFF_WIDGET_CSS_CLASS);
  // Wire the notebook view-mode selector into the `MainAreaWidget` toolbar
  // — the proper home for document chrome controls. The toolbar starts
  // hidden and becomes visible once the React content reports a parsed
  // notebook diff via `setHasNotebookView`. Plain text / code diffs never
  // flip that flag, and pin state can hide the toolbar again, so the host
  // chrome tracks the active mode.
  const pinButton = new ToolbarButton({
    icon: launchIcon,
    tooltip: 'Pin tab',
    onClick: () => content.pin()
  });
  if (content.pinned) {
    pinButton.hide();
  }
  widget.toolbar.addItem('pin', pinButton);
  widget.toolbar.addItem(
    'notebook-view-mode',
    new NotebookViewModeToolbarItem(content)
  );
  widget.toolbar.addItem('diff-style', new DiffStyleToolbarItem(content));
  const syncToolbarVisibility = (): void => {
    if (widget === null || widget.isDisposed) {
      return;
    }
    if (!content.pinned || content.hasNotebookView || content.fileDiffActive) {
      widget.toolbar.show();
    } else {
      widget.toolbar.hide();
    }
  };
  const onToolbarStateChanged = (): void => {
    if (widget === null || widget.isDisposed) {
      return;
    }
    syncToolbarVisibility();
  };
  const onPinnedChanged = (sender: DiffContentWidget, value: boolean): void => {
    if (widget === null || widget.isDisposed) {
      return;
    }
    void sender;
    if (value) {
      pinButton.hide();
      // Keep toolbar state and title styling consistent for promoted tabs.
      onPinned(widget);
      if (widget.isDisposed) {
        return;
      }
      widget.title.className = '';
    }
    syncToolbarVisibility();
  };
  content.hasNotebookViewChanged.connect(onToolbarStateChanged);
  content.fileDiffActiveChanged.connect(onToolbarStateChanged);
  content.pinnedChanged.connect(onPinnedChanged);
  syncToolbarVisibility();
  widget.disposed.connect(() => {
    content.hasNotebookViewChanged.disconnect(onToolbarStateChanged);
    content.fileDiffActiveChanged.disconnect(onToolbarStateChanged);
    content.pinnedChanged.disconnect(onPinnedChanged);
  });
  return widget;
}

export function updateGitDiffWidget(
  widget: MainAreaWidget<DiffContentWidget>,
  change: IFileChange
): void {
  widget.content.setChange(change);
  widget.title.label = formatTitle(change);
  widget.title.caption = change.path;
  widget.title.icon = getTreeIcon(change.path);
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
    this._pinned = options.pinned === true;
    this._notebookViewMode = readStoredNotebookViewMode();
    this._diffStyle = readStoredDiffStyle();
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

  /** The user's current split-vs-unified layout choice for file diffs. */
  get diffStyle(): DiffStyle {
    return this._diffStyle;
  }

  /** Update the diff layout and persist it across sessions. */
  setDiffStyle(style: DiffStyle): void {
    if (style === this._diffStyle) {
      return;
    }
    this._diffStyle = style;
    writeStoredDiffStyle(style);
    this._diffStyleChanged.emit(style);
  }

  /** Emits whenever {@link diffStyle} changes. */
  get diffStyleChanged(): ISignal<this, DiffStyle> {
    return this._diffStyleChanged;
  }

  /**
   * Whether the textual/code file diff (the only view the split-vs-unified
   * choice affects) is currently active. Set by the React content; the
   * toolbar reads it to decide whether to show the Split/Unified selector.
   */
  get fileDiffActive(): boolean {
    return this._fileDiffActive;
  }

  setFileDiffActive(value: boolean): void {
    if (value === this._fileDiffActive) {
      return;
    }
    this._fileDiffActive = value;
    this._fileDiffActiveChanged.emit(value);
  }

  /** Emits whenever {@link fileDiffActive} changes. */
  get fileDiffActiveChanged(): ISignal<this, boolean> {
    return this._fileDiffActiveChanged;
  }

  get pinned(): boolean {
    return this._pinned;
  }

  pin(): void {
    if (this._pinned) {
      return;
    }
    this._pinned = true;
    this._pinnedChanged.emit(true);
  }

  get pinnedChanged(): ISignal<this, boolean> {
    return this._pinnedChanged;
  }

  setChange(change: IFileChange): void {
    this._options = { ...this._options, change };
    this.update();
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
  private _diffStyle: DiffStyle;
  private _diffStyleChanged = new Signal<this, DiffStyle>(this);
  private _fileDiffActive = false;
  private _fileDiffActiveChanged = new Signal<this, boolean>(this);
  private _pinned: boolean;
  private _pinnedChanged = new Signal<this, boolean>(this);
}

interface IDiffState {
  loading: boolean;
  /**
   * Resolved old/reference and new/challenger text. The shared
   * {@link DiffSurface} turns these into the line/notebook diff; owning
   * only the raw strings here keeps the fetch path decoupled from how the
   * diff is rendered.
   */
  oldText: string;
  newText: string;
  /**
   * Server-relative path of the file on disk. Computed from the repo path
   * + the file's git-root-relative path. We need it to write the file back
   * via the contents manager when discarding a hunk.
   */
  serverPath: string;
  isBinary: boolean;
  error: string | null;
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
    oldText: '',
    newText: '',
    serverPath: '',
    isBinary: false,
    error: null
  });
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

  // Mirror the widget's diff-style choice the same way (the widget owns the
  // canonical value so the toolbar can read and write it without going
  // through React).
  const [diffStyle, setDiffStyleLocal] = React.useState<DiffStyle>(
    () => widget.diffStyle
  );
  React.useEffect(() => {
    const handler = (_sender: DiffContentWidget, style: DiffStyle): void => {
      setDiffStyleLocal(style);
    };
    widget.diffStyleChanged.connect(handler);
    setDiffStyleLocal(widget.diffStyle);
    return () => {
      widget.diffStyleChanged.disconnect(handler);
    };
  }, [widget]);

  // Tell the host widget whether the textual/code file diff is the active
  // view, so the toolbar's Split/Unified selector only shows when it applies.
  const handleFileDiffActiveChange = React.useCallback(
    (active: boolean) => {
      widget.setFileDiffActive(active);
    },
    [widget]
  );

  // Tell the host widget whether a rendered notebook view is currently
  // available. The toolbar item that lives in the `MainAreaWidget`
  // toolbar reads this flag to decide whether to show the
  // Notebook/JSON selector — and the toolbar bar itself stays hidden
  // when the file isn't a parseable notebook.
  const handleNotebookAvailabilityChange = React.useCallback(
    (available: boolean) => {
      widget.setHasNotebookView(available);
    },
    [widget]
  );

  // The shared surface reports its hunk count after every (re)computation;
  // we keep the latest so the auto-close-on-empty effect can fire after a
  // discard empties the diff.
  const [hunkCount, setHunkCount] = React.useState<number | null>(null);
  const handleMetadataChange = React.useCallback(
    (info: { hunkCount: number | null }) => {
      setHunkCount(info.hunkCount);
    },
    []
  );

  // Auto-close after a discard that emptied the diff. Gated on `reloadKey > 0`
  // so a file that opens already-empty (uncommon but possible) is not closed
  // before the user has had a chance to look at it.
  React.useEffect(() => {
    if (
      !state.loading &&
      state.error === null &&
      !state.isBinary &&
      hunkCount === 0 &&
      reloadKey > 0
    ) {
      onEmpty?.();
    }
  }, [
    state.loading,
    state.error,
    state.isBinary,
    hunkCount,
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
    const serverPath = toServerPath(repoPath, change.path);
    setState({
      loading: true,
      oldText: '',
      newText: '',
      serverPath,
      isBinary: false,
      error: null
    });
    const { oldRef, newRef } = resolveReferences(change);
    // Raster images are still binary, but the git server base64-encodes
    // binary content, so we fetch them like text and let the surface render
    // an image diff. Other binary files have no useful textual diff.
    const isImage = imageDataType(change.path) !== null;
    void (async () => {
      try {
        if (change.isBinary === true && !isImage) {
          if (cancelled) {
            return;
          }
          setState({
            loading: false,
            oldText: '',
            newText: '',
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
        setState({
          loading: false,
          oldText: oldRes.content ?? '',
          newText: newRes.content ?? '',
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
          oldText: '',
          newText: '',
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
  // version to revert to.
  const canDiscardHunk =
    change.group === 'unstaged' && change.status !== 'untracked';

  const hunkDiscard = React.useMemo(
    () => ({
      enabled: canDiscardHunk,
      save: async (text: string) => {
        await contentsManager.save(state.serverPath, {
          type: 'file',
          format: 'text',
          content: text
        });
      },
      onAfterSave: () => {
        onChanged();
        setReloadKey(key => key + 1);
      }
    }),
    [canDiscardHunk, contentsManager, onChanged, state.serverPath]
  );

  return (
    <DiffSurface
      loading={state.loading}
      error={state.error}
      isBinary={state.isBinary}
      oldText={state.oldText}
      newText={state.newText}
      newName={change.path}
      oldName={change.from ?? change.path}
      dark={dark}
      rendermime={rendermime}
      notebookViewMode={notebookViewMode}
      diffStyle={diffStyle}
      onNotebookAvailabilityChange={handleNotebookAvailabilityChange}
      onFileDiffActiveChange={handleFileDiffActiveChange}
      onMetadataChange={handleMetadataChange}
      hunkDiscard={hunkDiscard}
    />
  );
}

/**
 * Segmented Notebook/JSON selector mounted into the `MainAreaWidget`
 * toolbar for `.ipynb` diffs (launcher path). The selector reads from and
 * writes to the {@link DiffContentWidget} so React state changes (via the
 * diff content) and toolbar interactions stay in sync without either side
 * knowing about the other. The host toolbar widget's visibility is toggled
 * by {@link createGitDiffWidget} based on the same `hasNotebookView`
 * signal, so this control is always meaningful when it appears.
 */
class NotebookViewModeToolbarItem extends ReactWidget {
  constructor(content: DiffContentWidget) {
    super();
    this._content = content;
    this.addClass('jp-xtralab-DiffWidget-viewModeToolbarItem');
  }

  protected render(): React.ReactElement {
    return <NotebookViewModeToolbarControl content={this._content} />;
  }

  private _content: DiffContentWidget;
}

function NotebookViewModeToolbarControl(props: {
  content: DiffContentWidget;
}): React.ReactElement {
  const { content } = props;
  const [mode, setMode] = React.useState<NotebookDiffViewMode>(
    () => content.notebookViewMode
  );
  const [available, setAvailable] = React.useState<boolean>(
    () => content.hasNotebookView
  );
  React.useEffect(() => {
    const onMode = (
      _sender: DiffContentWidget,
      next: NotebookDiffViewMode
    ): void => {
      setMode(next);
    };
    const onAvailable = (_sender: DiffContentWidget, next: boolean): void => {
      setAvailable(next);
    };
    content.notebookViewModeChanged.connect(onMode);
    content.hasNotebookViewChanged.connect(onAvailable);
    setMode(content.notebookViewMode);
    setAvailable(content.hasNotebookView);
    return () => {
      content.notebookViewModeChanged.disconnect(onMode);
      content.hasNotebookViewChanged.disconnect(onAvailable);
    };
  }, [content]);

  return (
    <NotebookViewModeControl
      mode={mode}
      available={available}
      onChange={next => content.setNotebookViewMode(next)}
    />
  );
}

/**
 * Split/Unified selector mounted into the `MainAreaWidget` toolbar. Mirrors
 * {@link NotebookViewModeToolbarItem}: it reads from and writes to the
 * {@link DiffContentWidget} so toolbar interactions and React state stay in
 * sync, and only appears while the textual/code file diff is the active view
 * (driven by the same `fileDiffActive` signal that gates toolbar visibility).
 */
class DiffStyleToolbarItem extends ReactWidget {
  constructor(content: DiffContentWidget) {
    super();
    this._content = content;
    this.addClass('jp-xtralab-DiffWidget-diffStyleToolbarItem');
  }

  protected render(): React.ReactElement {
    return <DiffStyleToolbarControl content={this._content} />;
  }

  private _content: DiffContentWidget;
}

function DiffStyleToolbarControl(props: {
  content: DiffContentWidget;
}): React.ReactElement {
  const { content } = props;
  const [style, setStyle] = React.useState<DiffStyle>(() => content.diffStyle);
  const [available, setAvailable] = React.useState<boolean>(
    () => content.fileDiffActive
  );
  React.useEffect(() => {
    const onStyle = (_sender: DiffContentWidget, next: DiffStyle): void => {
      setStyle(next);
    };
    const onAvailable = (_sender: DiffContentWidget, next: boolean): void => {
      setAvailable(next);
    };
    content.diffStyleChanged.connect(onStyle);
    content.fileDiffActiveChanged.connect(onAvailable);
    setStyle(content.diffStyle);
    setAvailable(content.fileDiffActive);
    return () => {
      content.diffStyleChanged.disconnect(onStyle);
      content.fileDiffActiveChanged.disconnect(onAvailable);
    };
  }, [content]);

  return (
    <DiffStyleControl
      diffStyle={style}
      available={available}
      onChange={next => content.setDiffStyle(next)}
    />
  );
}

function formatTitle(change: IFileChange): string {
  const name = change.path.split('/').pop() ?? change.path;
  const groupLabel = change.group === 'staged' ? 'Staged' : 'Working';
  return `${name} (${groupLabel})`;
}
