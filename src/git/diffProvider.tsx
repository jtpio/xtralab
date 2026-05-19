import * as React from 'react';

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import { ReactWidget } from '@jupyterlab/ui-components';
import { Git, IGitExtension } from '@jupyterlab/git';
import { PromiseDelegate } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import {
  DIFF_WIDGET_CSS_CLASS,
  DiffSurface,
  NotebookViewModeControl,
  isDarkTheme,
  readStoredNotebookViewMode,
  writeStoredNotebookViewMode,
  type NotebookDiffViewMode
} from './diffSurface';
import { IMAGE_DIFF_EXTENSIONS } from './imageDiff';

/**
 * `jupyterlab-git` diff providers backed by xtralab's `@pierre/diffs`
 * rendering.
 *
 * jupyterlab-git's notebook, plain-text and image diff plugins are disabled
 * (see `package.json`); this module registers a diff factory in their place
 * via `registerDiffProvider` / `registerFallbackDiffProvider`. The upstream
 * git panel, commands, status bar and context menus keep working unchanged;
 * only the rendered diff is xtralab's.
 *
 * The factory adapts a `Git.Diff.IModel` (reference vs. challenger content
 * getters) onto the shared {@link DiffSurface}, so a diff opened from the
 * git panel looks identical to one opened from the launcher dashboard.
 */

interface IXtralabDiffContext {
  contentsManager: Contents.IManager;
  rendermime: IRenderMimeRegistry | null;
  themeManager: IThemeManager | null;
}

/**
 * A `Git.Diff.IDiffWidget` that renders through {@link DiffSurface}.
 *
 * `jupyterlab-git` constructs this via the registered factory, hosts it in
 * its own `PreviewMainAreaWidget`, and reads `model` / calls `refresh()` /
 * `getResolvedFile()` on it. It owns the notebook view-mode state (mounted
 * into the diff toolbar `jupyterlab-git` hands the factory) and a reload
 * nonce so `refresh()` re-pulls the model's content.
 */
class XtralabDiffWidget extends ReactWidget implements Git.Diff.IDiffWidget {
  constructor(model: Git.Diff.IModel, context: IXtralabDiffContext) {
    super();
    this._model = model;
    this._context = context;
    this._notebookViewMode = readStoredNotebookViewMode();
    // `jp-git-diff-root` borrows jupyterlab-git's host sizing (height:100%
    // flex column inside its PreviewMainAreaWidget); `jp-xtralab-DiffWidget`
    // brings our diff theming + the `.jp-xtralab-DiffWidget-*` styles.
    this.addClass('jp-git-diff-root');
    this.addClass(DIFF_WIDGET_CSS_CLASS);
  }

  /** The diff model, as required by `Git.Diff.IDiffWidget`. */
  get model(): Git.Diff.IModel {
    return this._model;
  }

  /**
   * We render a two-way (reference vs. challenger) view and do not provide
   * a merge editor, so there is nothing to leave unresolved — report
   * resolved so jupyterlab-git's merge-conflict flow is not blocked.
   */
  get isFileResolved(): boolean {
    return true;
  }

  /**
   * Used by jupyterlab-git's "Mark as resolved" button. Since we do not
   * offer in-diff merge editing, resolving keeps the current working copy
   * (the challenger) rather than fabricating a merged result.
   */
  async getResolvedFile(): Promise<Partial<Contents.IModel>> {
    const content = await this._model.challenger.content();
    return { type: 'file', format: 'text', content };
  }

  /**
   * Re-pull both sides of the model and re-render. jupyterlab-git wires a
   * "Refresh" toolbar button to this whenever `model.changed` fires (e.g.
   * the compared `HEAD` moved).
   */
  async refresh(): Promise<void> {
    const done = new PromiseDelegate<void>();
    this._pendingRefresh = done;
    this._reloadNonce += 1;
    this.update();
    await done.promise;
  }

  /** The notebook rendered-vs-JSON choice; mirrored into the toolbar. */
  get notebookViewMode(): NotebookDiffViewMode {
    return this._notebookViewMode;
  }

  setNotebookViewMode(mode: NotebookDiffViewMode): void {
    if (mode === this._notebookViewMode) {
      return;
    }
    this._notebookViewMode = mode;
    writeStoredNotebookViewMode(mode);
    this._notebookViewModeChanged.emit(mode);
  }

  get notebookViewModeChanged(): ISignal<this, NotebookDiffViewMode> {
    return this._notebookViewModeChanged;
  }

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

  get hasNotebookViewChanged(): ISignal<this, boolean> {
    return this._hasNotebookViewChanged;
  }

  /** Resolve the in-flight {@link refresh} promise, if any. */
  settleRefresh(): void {
    const pending = this._pendingRefresh;
    this._pendingRefresh = null;
    pending?.resolve();
  }

  get reloadNonce(): number {
    return this._reloadNonce;
  }

  get context(): IXtralabDiffContext {
    return this._context;
  }

  protected render(): React.ReactElement {
    return <ModelDiffView widget={this} />;
  }

  private _model: Git.Diff.IModel;
  private _context: IXtralabDiffContext;
  private _reloadNonce = 0;
  private _pendingRefresh: PromiseDelegate<void> | null = null;
  private _notebookViewMode: NotebookDiffViewMode;
  private _notebookViewModeChanged = new Signal<this, NotebookDiffViewMode>(
    this
  );
  private _hasNotebookView = false;
  private _hasNotebookViewChanged = new Signal<this, boolean>(this);
}

interface IModelDiffState {
  loading: boolean;
  oldText: string;
  newText: string;
  error: string | null;
}

function ModelDiffView(props: {
  widget: XtralabDiffWidget;
}): React.ReactElement {
  const { widget } = props;
  const model = widget.model;
  const { contentsManager, rendermime, themeManager } = widget.context;
  const nonce = widget.reloadNonce;

  const [state, setState] = React.useState<IModelDiffState>({
    loading: true,
    oldText: '',
    newText: '',
    error: null
  });

  // Mirror the widget's notebook view mode so toolbar-driven changes
  // re-render the diff. The widget owns the canonical value (so the
  // toolbar can read/write it without going through React).
  const [notebookViewMode, setNotebookViewMode] =
    React.useState<NotebookDiffViewMode>(() => widget.notebookViewMode);
  React.useEffect(() => {
    const handler = (
      _sender: XtralabDiffWidget,
      mode: NotebookDiffViewMode
    ): void => {
      setNotebookViewMode(mode);
    };
    widget.notebookViewModeChanged.connect(handler);
    setNotebookViewMode(widget.notebookViewMode);
    return () => {
      widget.notebookViewModeChanged.disconnect(handler);
    };
  }, [widget]);

  const handleNotebookAvailabilityChange = React.useCallback(
    (available: boolean) => {
      widget.setHasNotebookView(available);
    },
    [widget]
  );

  const [dark, setDark] = React.useState<boolean>(() =>
    isDarkTheme(themeManager)
  );
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

  // Fetch both sides whenever the model or the reload nonce changes. The
  // model's `content()` getters target the right git refs internally
  // (working tree, index, a commit, …) so we stay content-source-agnostic.
  React.useEffect(() => {
    let cancelled = false;
    setState({ loading: true, oldText: '', newText: '', error: null });
    void (async () => {
      try {
        const [oldText, newText] = await Promise.all([
          model.reference.content(),
          model.challenger.content()
        ]);
        if (cancelled) {
          return;
        }
        setState({
          loading: false,
          oldText: oldText ?? '',
          newText: newText ?? '',
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
          error: err instanceof Error ? err.message : String(err)
        });
      } finally {
        if (!cancelled) {
          // Let an in-flight `widget.refresh()` resolve once the reload
          // has settled (jupyterlab-git only awaits it to hide its
          // refresh button).
          widget.settleRefresh();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [widget, model, nonce]);

  // Per-hunk discard is only meaningful when the challenger is the working
  // tree (an unstaged change) and we are not in a three-way merge view.
  const canDiscardHunk =
    model.challenger.source === Git.Diff.SpecialRef.WORKING &&
    model.hasConflict !== true;

  const serverPath = React.useMemo(
    () => PathExt.join(model.repositoryPath ?? '', model.filename),
    [model.repositoryPath, model.filename]
  );

  const hunkDiscard = React.useMemo(
    () => ({
      enabled: canDiscardHunk,
      save: async (text: string) => {
        await contentsManager.save(serverPath, {
          type: 'file',
          format: 'text',
          content: text
        });
      },
      onAfterSave: () => {
        // jupyterlab-git's panel auto-refreshes off the contents
        // `fileChanged` signal the save above emits; we just need to
        // re-pull so the diff reflects the reverted hunk. (We do not
        // auto-close: jupyterlab-git owns the diff tab.)
        void widget.refresh();
      }
    }),
    [canDiscardHunk, contentsManager, serverPath, widget]
  );

  return (
    <DiffSurface
      loading={state.loading}
      error={state.error}
      isBinary={false}
      oldText={state.oldText}
      newText={state.newText}
      newName={model.filename}
      oldName={model.filename}
      dark={dark}
      rendermime={rendermime}
      notebookViewMode={notebookViewMode}
      onNotebookAvailabilityChange={handleNotebookAvailabilityChange}
      hunkDiscard={hunkDiscard}
    />
  );
}

/**
 * Notebook/JSON toggle mounted into the diff toolbar that jupyterlab-git
 * passes to the factory. Bound to the widget's signals so it stays in sync
 * with the rendered surface and only appears for parseable notebooks.
 */
class NotebookViewModeToolbarItem extends ReactWidget {
  constructor(widget: XtralabDiffWidget) {
    super();
    this._widget = widget;
    this.addClass('jp-xtralab-DiffWidget-viewModeToolbarItem');
  }

  protected render(): React.ReactElement {
    return <ToolbarControl widget={this._widget} />;
  }

  private _widget: XtralabDiffWidget;
}

function ToolbarControl(props: {
  widget: XtralabDiffWidget;
}): React.ReactElement {
  const { widget } = props;
  const [mode, setMode] = React.useState<NotebookDiffViewMode>(
    () => widget.notebookViewMode
  );
  const [available, setAvailable] = React.useState<boolean>(
    () => widget.hasNotebookView
  );
  React.useEffect(() => {
    const onMode = (
      _sender: XtralabDiffWidget,
      next: NotebookDiffViewMode
    ): void => {
      setMode(next);
    };
    const onAvailable = (_sender: XtralabDiffWidget, next: boolean): void => {
      setAvailable(next);
    };
    widget.notebookViewModeChanged.connect(onMode);
    widget.hasNotebookViewChanged.connect(onAvailable);
    setMode(widget.notebookViewMode);
    setAvailable(widget.hasNotebookView);
    return () => {
      widget.notebookViewModeChanged.disconnect(onMode);
      widget.hasNotebookViewChanged.disconnect(onAvailable);
    };
  }, [widget]);

  return (
    <NotebookViewModeControl
      mode={mode}
      available={available}
      onChange={next => widget.setNotebookViewMode(next)}
    />
  );
}

/**
 * Build the `Git.Diff.Factory` xtralab registers with jupyterlab-git. The
 * factory closes over the application-level context (contents manager for
 * hunk discard, rendermime for notebook outputs, theme manager) that the
 * `Git.Diff.IFactoryOptions` does not carry.
 */
function makeXtralabDiffFactory(
  context: IXtralabDiffContext
): Git.Diff.Factory {
  return async (options: Git.Diff.IFactoryOptions) => {
    const widget = new XtralabDiffWidget(options.model, context);
    if (options.toolbar) {
      options.toolbar.addItem(
        'xtralab-notebook-view-mode',
        new NotebookViewModeToolbarItem(widget)
      );
    }
    return widget;
  };
}

/**
 * Registers xtralab's diff rendering as jupyterlab-git's diff providers:
 * `@pierre/diffs` for text and notebooks, the bundled `<img>`-based view
 * for raster images.
 */
const diffProviderPlugin: JupyterFrontEndPlugin<void> = {
  id: 'xtralab:git-diff-providers',
  description:
    "Replaces jupyterlab-git's notebook, text and image diff plugins with xtralab's renderer.",
  autoStart: true,
  requires: [IGitExtension],
  optional: [IRenderMimeRegistry, IThemeManager],
  activate: (
    app: JupyterFrontEnd,
    gitExtension: IGitExtension,
    rendermime: IRenderMimeRegistry | null,
    themeManager: IThemeManager | null
  ): void => {
    const factory = makeXtralabDiffFactory({
      contentsManager: app.serviceManager.contents,
      rendermime,
      themeManager
    });

    // Notebooks and raster images get extension-specific providers; every
    // other text file falls back to the same factory. One factory serves
    // all three — the surface auto-detects notebooks/images by filename.
    gitExtension.registerDiffProvider('XtralabNotebook', ['.ipynb'], factory);
    gitExtension.registerDiffProvider(
      'XtralabImage',
      IMAGE_DIFF_EXTENSIONS,
      factory
    );
    gitExtension.registerFallbackDiffProvider(factory);
  }
};

export default diffProviderPlugin;
