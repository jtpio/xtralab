import * as React from 'react';

import { IThemeManager } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { Git } from '@jupyterlab/git';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import type { TranslationBundle } from '@jupyterlab/translation';
import { ReactWidget } from '@jupyterlab/ui-components';
import { PromiseDelegate } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { SelectedLineRange } from '@pierre/diffs';

import type { IAskAgent } from '../askAgent/tokens';

import { buildDiffAskRequest } from './askRequest';
import {
  DIFF_WIDGET_CSS_CLASS,
  DiffStyleControl,
  DiffSurface,
  NotebookViewModeControl,
  isDarkTheme,
  isPierreTheme,
  readStoredDiffStyle,
  readStoredNotebookViewMode,
  writeStoredDiffStyle,
  writeStoredNotebookViewMode,
  type DiffStyle,
  type NotebookDiffViewMode
} from './diffSurface';
import { imageDataType } from './imageDiff';

export { DIFF_WIDGET_CSS_CLASS };

/**
 * `Git.Diff.IModel` plus optional xtralab-only metadata.
 */
export interface IXtralabDiffModel extends Git.Diff.IModel {
  /**
   * Whether the file is binary, so no text contents are fetched.
   */
  isBinary?: boolean;
  /**
   * Whether hunks may be discarded; when absent, a working-tree heuristic decides.
   */
  canDiscard?: boolean;
  /**
   * The old-side path when the diff represents a rename.
   */
  oldFilename?: string;
}

/**
 * Application-level services the diff model does not carry.
 */
export interface IXtralabDiffContext {
  /**
   * The contents manager used to save hunk-discard results.
   */
  contentsManager: Contents.IManager;
  /**
   * The rendermime registry for rendered notebook diffs, or `null` to
   * force the textual fallback.
   */
  rendermime: IRenderMimeRegistry | null;
  /**
   * The theme manager used to track theme changes, or `null` to watch
   * the body attribute instead.
   */
  themeManager: IThemeManager | null;
  /**
   * When available, diff line selections get an "ask an agent" gutter button.
   */
  askAgent: IAskAgent | null;
  /**
   * The application translation bundle.
   */
  trans: TranslationBundle;
}

/**
 * Shared diff widget used by the launcher and by `jupyterlab-git`.
 */
export class XtralabDiffWidget
  extends ReactWidget
  implements Git.Diff.IDiffWidget
{
  constructor(model: Git.Diff.IModel, context: IXtralabDiffContext) {
    super();
    this._model = model;
    this._context = context;
    this._notebookViewMode = readStoredNotebookViewMode();
    this._diffStyle = readStoredDiffStyle();
    // Reuse jupyterlab-git's host sizing while applying xtralab styling.
    this.addClass('jp-git-diff-root');
    this.addClass(DIFF_WIDGET_CSS_CLASS);
  }

  /**
   * The git diff model being rendered.
   */
  get model(): Git.Diff.IModel {
    return this._model;
  }

  /**
   * Swap the rendered model when the launcher reuses its preview tab.
   */
  setModel(model: IXtralabDiffModel): void {
    this._model = model;
    this.update();
  }

  /**
   * This renderer has no merge editor, so it never blocks mark-as-resolved.
   */
  get isFileResolved(): boolean {
    return true;
  }

  /**
   * Return the content jupyterlab-git should save for mark-as-resolved.
   */
  async getResolvedFile(): Promise<Partial<Contents.IModel>> {
    const source =
      this._model.hasConflict === true && this._model.base !== undefined
        ? this._model.base
        : this._model.challenger;
    const content = await source.content();
    return {
      type: 'file',
      format: imageDataType(this._model.filename) !== null ? 'base64' : 'text',
      content
    };
  }

  /**
   * Re-pull both sides of the model and re-render.
   */
  async refresh(): Promise<void> {
    // Settle any refresh still awaiting so a rapid second call cannot orphan
    // the earlier caller's promise.
    this.settleRefresh();
    const done = new PromiseDelegate<void>();
    this._pendingRefresh = done;
    this._reloadNonce += 1;
    this.update();
    await done.promise;
  }

  /**
   * The current rendered-vs-JSON choice for notebook diffs.
   */
  get notebookViewMode(): NotebookDiffViewMode {
    return this._notebookViewMode;
  }

  /**
   * Set the notebook view mode and persist it.
   */
  setNotebookViewMode(mode: NotebookDiffViewMode): void {
    if (mode === this._notebookViewMode) {
      return;
    }
    this._notebookViewMode = mode;
    writeStoredNotebookViewMode(mode);
    this._notebookViewModeChanged.emit(mode);
  }

  /**
   * A signal emitted when the notebook view mode changes.
   */
  get notebookViewModeChanged(): ISignal<this, NotebookDiffViewMode> {
    return this._notebookViewModeChanged;
  }

  /**
   * Whether a rendered notebook view is currently available.
   */
  get hasNotebookView(): boolean {
    return this._hasNotebookView;
  }

  /**
   * Set whether a rendered notebook view is available.
   */
  setHasNotebookView(value: boolean): void {
    if (value === this._hasNotebookView) {
      return;
    }
    this._hasNotebookView = value;
    this._hasNotebookViewChanged.emit(value);
  }

  /**
   * A signal emitted when rendered-notebook availability changes.
   */
  get hasNotebookViewChanged(): ISignal<this, boolean> {
    return this._hasNotebookViewChanged;
  }

  /**
   * The current split/unified layout for textual file diffs.
   */
  get diffStyle(): DiffStyle {
    return this._diffStyle;
  }

  /**
   * Set the diff style and persist it.
   */
  setDiffStyle(style: DiffStyle): void {
    if (style === this._diffStyle) {
      return;
    }
    this._diffStyle = style;
    writeStoredDiffStyle(style);
    this._diffStyleChanged.emit(style);
  }

  /**
   * A signal emitted when the diff style changes.
   */
  get diffStyleChanged(): ISignal<this, DiffStyle> {
    return this._diffStyleChanged;
  }

  /**
   * Whether the Split/Unified toolbar selector currently applies.
   */
  get fileDiffActive(): boolean {
    return this._fileDiffActive;
  }

  /**
   * Set whether the textual file diff is the active view.
   */
  setFileDiffActive(value: boolean): void {
    if (value === this._fileDiffActive) {
      return;
    }
    this._fileDiffActive = value;
    this._fileDiffActiveChanged.emit(value);
  }

  /**
   * A signal emitted when {@link fileDiffActive} changes.
   */
  get fileDiffActiveChanged(): ISignal<this, boolean> {
    return this._fileDiffActiveChanged;
  }

  /**
   * Emitted when a post-discard reload leaves the diff with no hunks.
   */
  get emptied(): ISignal<this, void> {
    return this._emptied;
  }

  /**
   * Emit the {@link emptied} signal.
   */
  notifyEmptied(): void {
    this._emptied.emit();
  }

  /**
   * Resolve and clear the pending `refresh()` promise, if any.
   */
  settleRefresh(): void {
    const pending = this._pendingRefresh;
    this._pendingRefresh = null;
    pending?.resolve();
  }

  /**
   * Dispose of the resources held by the widget.
   */
  dispose(): void {
    // jupyterlab-git awaits refresh() to re-show its diff button; release any
    // in-flight awaiter so it does not hang on mid-fetch teardown.
    this.settleRefresh();
    super.dispose();
  }

  /**
   * A counter incremented on each `refresh()` to trigger a content re-fetch.
   */
  get reloadNonce(): number {
    return this._reloadNonce;
  }

  /**
   * The application-level services used by the rendered diff.
   */
  get context(): IXtralabDiffContext {
    return this._context;
  }

  /**
   * Render the diff view for the current model.
   */
  protected render(): React.ReactElement {
    return <ModelDiffView widget={this} />;
  }

  private _model: IXtralabDiffModel;
  private _context: IXtralabDiffContext;
  private _reloadNonce = 0;
  private _pendingRefresh: PromiseDelegate<void> | null = null;
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
  private _emptied = new Signal<this, void>(this);
}

/**
 * Resolved file-contents state for {@link ModelDiffView}.
 */
interface IModelDiffState {
  /**
   * Whether the file contents are still being fetched.
   */
  loading: boolean;
  /**
   * The resolved reference-side text.
   */
  oldText: string;
  /**
   * The resolved challenger-side text.
   */
  newText: string;
  /**
   * The fetch error message, or `null` if none.
   */
  error: string | null;
}

function ModelDiffView(props: {
  widget: XtralabDiffWidget;
}): React.ReactElement {
  const { widget } = props;
  const model = widget.model as IXtralabDiffModel;
  const { contentsManager, rendermime, themeManager, askAgent, trans } =
    widget.context;
  const nonce = widget.reloadNonce;

  const [state, setState] = React.useState<IModelDiffState>({
    loading: true,
    oldText: '',
    newText: '',
    error: null
  });

  const [notebookViewMode, setNotebookViewMode] =
    React.useState<NotebookDiffViewMode>(() => widget.notebookViewMode);
  React.useEffect(() => {
    const handler = (
      sender: XtralabDiffWidget,
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

  const [diffStyle, setDiffStyle] = React.useState<DiffStyle>(
    () => widget.diffStyle
  );
  React.useEffect(() => {
    const handler = (sender: XtralabDiffWidget, style: DiffStyle): void => {
      setDiffStyle(style);
    };
    widget.diffStyleChanged.connect(handler);
    setDiffStyle(widget.diffStyle);
    return () => {
      widget.diffStyleChanged.disconnect(handler);
    };
  }, [widget]);

  const handleFileDiffActiveChange = React.useCallback(
    (active: boolean) => {
      widget.setFileDiffActive(active);
    },
    [widget]
  );

  const [dark, setDark] = React.useState<boolean>(() =>
    isDarkTheme(themeManager)
  );
  const [pierre, setPierre] = React.useState<boolean>(() =>
    isPierreTheme(themeManager)
  );
  React.useEffect(() => {
    const sync = (): void => {
      setDark(isDarkTheme(themeManager));
      setPierre(isPierreTheme(themeManager));
    };
    if (themeManager !== null) {
      themeManager.themeChanged.connect(sync);
      return () => {
        themeManager.themeChanged.disconnect(sync);
      };
    }
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-jp-theme-light']
    });
    return () => {
      observer.disconnect();
    };
  }, [themeManager]);

  const isImage = React.useMemo(
    () => imageDataType(model.filename) !== null,
    [model.filename]
  );
  const isBinary = model.isBinary === true && !isImage;

  const [hunkCount, setHunkCount] = React.useState<number | null>(null);
  const handleMetadataChange = React.useCallback(
    (info: { hunkCount: number | null }) => {
      setHunkCount(info.hunkCount);
    },
    []
  );

  React.useEffect(() => {
    let cancelled = false;
    if (isBinary) {
      setState({ loading: false, oldText: '', newText: '', error: null });
      // An in-flight `refresh()` still has to resolve.
      widget.settleRefresh();
      return () => {
        cancelled = true;
      };
    }
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
          widget.settleRefresh();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [widget, model, nonce, isBinary]);

  // Only close after a reload, not for a file that opens already empty.
  React.useEffect(() => {
    if (
      !state.loading &&
      state.error === null &&
      !isBinary &&
      hunkCount === 0 &&
      nonce > 0
    ) {
      widget.notifyEmptied();
    }
  }, [state.loading, state.error, isBinary, hunkCount, nonce, widget]);

  const canDiscardHunk =
    model.canDiscard ??
    (model.challenger.source === Git.Diff.SpecialRef.WORKING &&
      model.hasConflict !== true);

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
        void widget.refresh();
      }
    }),
    [canDiscardHunk, contentsManager, serverPath, widget]
  );

  const handleLineAsk = React.useMemo(() => {
    if (askAgent === null) {
      return undefined;
    }
    return (range: SelectedLineRange, anchor: DOMRect | null): void => {
      askAgent.open(
        buildDiffAskRequest({
          model,
          oldText: state.oldText,
          newText: state.newText,
          range,
          anchor,
          trans
        })
      );
    };
  }, [askAgent, model, state.oldText, state.newText, trans]);

  return (
    <DiffSurface
      loading={state.loading}
      error={state.error}
      isBinary={isBinary}
      oldText={state.oldText}
      newText={state.newText}
      newName={model.filename}
      oldName={model.oldFilename ?? model.filename}
      dark={dark}
      pierreTheme={pierre}
      rendermime={rendermime}
      notebookViewMode={notebookViewMode}
      diffStyle={diffStyle}
      onNotebookAvailabilityChange={handleNotebookAvailabilityChange}
      onFileDiffActiveChange={handleFileDiffActiveChange}
      onMetadataChange={handleMetadataChange}
      hunkDiscard={hunkDiscard}
      onLineAsk={handleLineAsk}
      trans={trans}
    />
  );
}

/**
 * Notebook/JSON toggle mounted into a host-owned toolbar.
 */
class NotebookViewModeToolbarItem extends ReactWidget {
  constructor(widget: XtralabDiffWidget) {
    super();
    this._widget = widget;
    this.addClass('jp-xtralab-DiffWidget-viewModeToolbarItem');
  }

  /**
   * Render the Notebook/JSON toggle.
   */
  protected render(): React.ReactElement {
    return <NotebookViewModeToolbarControl widget={this._widget} />;
  }

  private _widget: XtralabDiffWidget;
}

function NotebookViewModeToolbarControl(props: {
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
      sender: XtralabDiffWidget,
      next: NotebookDiffViewMode
    ): void => {
      setMode(next);
    };
    const onAvailable = (sender: XtralabDiffWidget, next: boolean): void => {
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

  const trans = widget.context.trans;
  return (
    <NotebookViewModeControl
      mode={mode}
      available={available}
      onChange={next => widget.setNotebookViewMode(next)}
      trans={trans}
    />
  );
}

/**
 * Split/Unified toggle mounted into a host-owned toolbar.
 */
class DiffStyleToolbarItem extends ReactWidget {
  constructor(widget: XtralabDiffWidget) {
    super();
    this._widget = widget;
    this.addClass('jp-xtralab-DiffWidget-diffStyleToolbarItem');
  }

  /**
   * Render the Split/Unified toggle.
   */
  protected render(): React.ReactElement {
    return <DiffStyleToolbarControl widget={this._widget} />;
  }

  private _widget: XtralabDiffWidget;
}

function DiffStyleToolbarControl(props: {
  widget: XtralabDiffWidget;
}): React.ReactElement {
  const { widget } = props;
  const [style, setStyle] = React.useState<DiffStyle>(() => widget.diffStyle);
  const [available, setAvailable] = React.useState<boolean>(
    () => widget.fileDiffActive
  );
  React.useEffect(() => {
    const onStyle = (sender: XtralabDiffWidget, next: DiffStyle): void => {
      setStyle(next);
    };
    const onAvailable = (sender: XtralabDiffWidget, next: boolean): void => {
      setAvailable(next);
    };
    widget.diffStyleChanged.connect(onStyle);
    widget.fileDiffActiveChanged.connect(onAvailable);
    setStyle(widget.diffStyle);
    setAvailable(widget.fileDiffActive);
    return () => {
      widget.diffStyleChanged.disconnect(onStyle);
      widget.fileDiffActiveChanged.disconnect(onAvailable);
    };
  }, [widget]);

  const trans = widget.context.trans;
  return (
    <DiffStyleControl
      diffStyle={style}
      available={available}
      onChange={next => widget.setDiffStyle(next)}
      trans={trans}
    />
  );
}

/**
 * Structural toolbar type shared across host package boundaries.
 */
interface IDiffToolbar {
  /**
   * Add an item to the toolbar under the given name.
   */
  addItem(name: string, widget: Widget): boolean;
}

/**
 * Mount the shared diff toolbar controls into a host-owned toolbar.
 */
export function addDiffToolbarItems(
  toolbar: IDiffToolbar,
  widget: XtralabDiffWidget
): void {
  toolbar.addItem(
    'xtralab-notebook-view-mode',
    new NotebookViewModeToolbarItem(widget)
  );
  toolbar.addItem('xtralab-diff-style', new DiffStyleToolbarItem(widget));
}
