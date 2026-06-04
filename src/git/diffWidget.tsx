import * as React from 'react';

import { IThemeManager } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { Git } from '@jupyterlab/git';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import { ReactWidget } from '@jupyterlab/ui-components';
import { PromiseDelegate } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';

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

/** `Git.Diff.IModel` plus optional xtralab-only metadata. */
export interface IXtralabDiffModel extends Git.Diff.IModel {
  isBinary?: boolean;
  canDiscard?: boolean;
  oldFilename?: string;
}

/** Application-level services the diff model does not carry. */
export interface IXtralabDiffContext {
  contentsManager: Contents.IManager;
  rendermime: IRenderMimeRegistry | null;
  themeManager: IThemeManager | null;
}

/** Shared diff widget used by the launcher and by `jupyterlab-git`. */
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

  get model(): Git.Diff.IModel {
    return this._model;
  }

  /** Swap the rendered model when the launcher reuses its preview tab. */
  setModel(model: IXtralabDiffModel): void {
    this._model = model;
    this.update();
  }

  /** This renderer has no merge editor, so it never blocks mark-as-resolved. */
  get isFileResolved(): boolean {
    return true;
  }

  /** Return the content jupyterlab-git should save for mark-as-resolved. */
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

  /** Re-pull both sides of the model and re-render. */
  async refresh(): Promise<void> {
    const done = new PromiseDelegate<void>();
    this._pendingRefresh = done;
    this._reloadNonce += 1;
    this.update();
    await done.promise;
  }

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

  get diffStyle(): DiffStyle {
    return this._diffStyle;
  }

  setDiffStyle(style: DiffStyle): void {
    if (style === this._diffStyle) {
      return;
    }
    this._diffStyle = style;
    writeStoredDiffStyle(style);
    this._diffStyleChanged.emit(style);
  }

  get diffStyleChanged(): ISignal<this, DiffStyle> {
    return this._diffStyleChanged;
  }

  /** Whether the Split/Unified toolbar selector currently applies. */
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

  get fileDiffActiveChanged(): ISignal<this, boolean> {
    return this._fileDiffActiveChanged;
  }

  /** Emitted when a post-discard reload leaves the diff with no hunks. */
  get emptied(): ISignal<this, void> {
    return this._emptied;
  }

  notifyEmptied(): void {
    this._emptied.emit();
  }

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
  const model = widget.model as IXtralabDiffModel;
  const { contentsManager, rendermime, themeManager } = widget.context;
  const nonce = widget.reloadNonce;

  const [state, setState] = React.useState<IModelDiffState>({
    loading: true,
    oldText: '',
    newText: '',
    error: null
  });

  // Mirror toolbar-driven notebook view changes into React state.
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

  // Mirror toolbar-driven diff-style changes into React state.
  const [diffStyle, setDiffStyle] = React.useState<DiffStyle>(
    () => widget.diffStyle
  );
  React.useEffect(() => {
    const handler = (_sender: XtralabDiffWidget, style: DiffStyle): void => {
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

  // Image diffs use the server's base64 payloads; other binaries show a placeholder.
  const isImage = React.useMemo(
    () => imageDataType(model.filename) !== null,
    [model.filename]
  );
  const isBinary = model.isBinary === true && !isImage;

  // Used by the launcher to auto-close an emptied diff after discard.
  const [hunkCount, setHunkCount] = React.useState<number | null>(null);
  const handleMetadataChange = React.useCallback(
    (info: { hunkCount: number | null }) => {
      setHunkCount(info.hunkCount);
    },
    []
  );

  // Fetch both sides whenever the model or reload nonce changes.
  React.useEffect(() => {
    let cancelled = false;
    // Non-image binaries do not need content fetches.
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
          // Let `refresh()` settle once content has loaded.
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

  // The launcher sets `canDiscard`; jupyterlab-git models fall back to source.
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
        // Re-pull so the diff reflects the reverted hunk.
        void widget.refresh();
      }
    }),
    [canDiscardHunk, contentsManager, serverPath, widget]
  );

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
    />
  );
}

/** Notebook/JSON toggle mounted into a host-owned toolbar. */
class NotebookViewModeToolbarItem extends ReactWidget {
  constructor(widget: XtralabDiffWidget) {
    super();
    this._widget = widget;
    this.addClass('jp-xtralab-DiffWidget-viewModeToolbarItem');
  }

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

/** Split/Unified toggle mounted into a host-owned toolbar. */
class DiffStyleToolbarItem extends ReactWidget {
  constructor(widget: XtralabDiffWidget) {
    super();
    this._widget = widget;
    this.addClass('jp-xtralab-DiffWidget-diffStyleToolbarItem');
  }

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
    const onStyle = (_sender: XtralabDiffWidget, next: DiffStyle): void => {
      setStyle(next);
    };
    const onAvailable = (_sender: XtralabDiffWidget, next: boolean): void => {
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

  return (
    <DiffStyleControl
      diffStyle={style}
      available={available}
      onChange={next => widget.setDiffStyle(next)}
    />
  );
}

/** Structural toolbar type shared across host package boundaries. */
interface IDiffToolbar {
  addItem(name: string, widget: Widget): boolean;
}

/** Mount the shared diff toolbar controls into a host-owned toolbar. */
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
