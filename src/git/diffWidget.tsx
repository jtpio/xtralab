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
 * `Git.Diff.IModel` plus the extra facts the bare interface cannot carry but
 * xtralab's diff view needs:
 *
 *   - `isBinary` — a non-image binary file shows the "binary" placeholder
 *     instead of a meaningless text diff,
 *   - `canDiscard` — whether per-hunk discard applies, and
 *   - `oldFilename` — the previous path of a renamed file, so the old side is
 *     labelled (and language-detected) from its real name.
 *
 * All three are optional, so a plain `Git.Diff.IModel` handed in by
 * `jupyterlab-git` is a valid `IXtralabDiffModel`: `isBinary` defaults to
 * false, the old side falls back to `filename`, and the view derives discard
 * eligibility from the challenger's `source` when `canDiscard` is absent. The
 * launcher path fills these in via `fileChangeToDiffModel` (see
 * `diffModel.ts`).
 */
export interface IXtralabDiffModel extends Git.Diff.IModel {
  isBinary?: boolean;
  canDiscard?: boolean;
  oldFilename?: string;
}

/**
 * Application-level context the diff view needs but `Git.Diff.IModel` does
 * not carry: the contents manager (to write hunk-discard results back to the
 * working tree), the rendermime registry (notebook outputs / markdown) and
 * the theme manager.
 */
export interface IXtralabDiffContext {
  contentsManager: Contents.IManager;
  rendermime: IRenderMimeRegistry | null;
  themeManager: IThemeManager | null;
}

/**
 * The single diff widget used by both hosts in this extension:
 *
 *   - `jupyterlab-git`'s panel, via the providers registered in
 *     `diffProvider.tsx` — jupyterlab-git constructs it through the factory
 *     and hosts it in its own `PreviewMainAreaWidget`, and
 *   - the launcher dashboard's `xtralab:git:open-diff` command, via the
 *     `MainAreaWidget` host in `commands.ts` — xtralab constructs it and
 *     feeds it a model built by `fileChangeToDiffModel`.
 *
 * It implements `Git.Diff.IDiffWidget` so jupyterlab-git can drive it
 * (`model` / `refresh()` / `getResolvedFile()` / `isFileResolved`), owns the
 * toolbar state both hosts mount via {@link addDiffToolbarItems}, and renders
 * through the shared {@link DiffSurface}.
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
    // `jp-git-diff-root` borrows jupyterlab-git's host sizing (height:100%
    // flex column inside its PreviewMainAreaWidget); `jp-xtralab-DiffWidget`
    // brings our diff theming. The launcher's `MainAreaWidget` lays the
    // widget out to fill too, so the `.jp-xtralab-DiffWidget-content` flex
    // column resolves the same way in both hosts.
    this.addClass('jp-git-diff-root');
    this.addClass(DIFF_WIDGET_CSS_CLASS);
  }

  /** The diff model, as required by `Git.Diff.IDiffWidget`. */
  get model(): Git.Diff.IModel {
    return this._model;
  }

  /**
   * Swap the rendered model and re-render. Used by the launcher host to reuse
   * its single preview tab for a different file without disposing the widget;
   * jupyterlab-git never calls this (it disposes and recreates instead).
   */
  setModel(model: IXtralabDiffModel): void {
    this._model = model;
    this.update();
  }

  /**
   * We render a two-way (reference vs. challenger) view and do not provide a
   * merge editor, so there is nothing to leave unresolved — report resolved
   * so jupyterlab-git's merge-conflict flow is not blocked.
   */
  get isFileResolved(): boolean {
    return true;
  }

  /**
   * Used by jupyterlab-git's "Mark as resolved" button. For merge conflicts,
   * jupyterlab-git passes the working-tree result as `base`; keep that content
   * rather than overwriting it with either compared side.
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
   * Re-pull both sides of the model and re-render. jupyterlab-git wires a
   * "Refresh" toolbar button to this whenever `model.changed` fires; the
   * launcher's hunk-discard flow calls it to reflect the reverted hunk.
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

  /** The user's current split-vs-unified layout choice for file diffs. */
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

  /**
   * Whether the textual/code file diff (the only view the split-vs-unified
   * choice affects) is currently active; mirrored into the toolbar so the
   * Split/Unified selector only shows when it applies.
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

  get fileDiffActiveChanged(): ISignal<this, boolean> {
    return this._fileDiffActiveChanged;
  }

  /**
   * Emitted when a post-discard reload leaves the diff with no hunks. The
   * launcher host connects to this to auto-close the emptied tab; the
   * jupyterlab-git host ignores it (it owns its own tab lifecycle).
   */
  get emptied(): ISignal<this, void> {
    return this._emptied;
  }

  notifyEmptied(): void {
    this._emptied.emit();
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

  // Mirror the widget's diff-style choice so toolbar-driven changes
  // re-render the diff. The widget owns the canonical value.
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

  // Raster images are still binary, but the git server base64-encodes them
  // and the surface renders an image diff from the two encoded sides, so we
  // fetch them like text. Only non-image binaries get the placeholder.
  const isImage = React.useMemo(
    () => imageDataType(model.filename) !== null,
    [model.filename]
  );
  const isBinary = model.isBinary === true && !isImage;

  // The surface reports its hunk count after every (re)computation; we keep
  // the latest so the auto-close-on-empty effect can fire after a discard
  // empties the diff.
  const [hunkCount, setHunkCount] = React.useState<number | null>(null);
  const handleMetadataChange = React.useCallback(
    (info: { hunkCount: number | null }) => {
      setHunkCount(info.hunkCount);
    },
    []
  );

  // Fetch both sides whenever the model or the reload nonce changes. The
  // model's `content()` getters target the right git refs internally
  // (working tree, index, a commit, …) so we stay content-source-agnostic.
  React.useEffect(() => {
    let cancelled = false;
    // Non-image binaries have no useful textual diff; skip the fetch and let
    // the surface show its binary placeholder.
    if (isBinary) {
      setState({ loading: false, oldText: '', newText: '', error: null });
      // No async fetch here, but an in-flight `refresh()` still has to
      // resolve — jupyterlab-git awaits it to hide its refresh spinner.
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
          // Let an in-flight `widget.refresh()` resolve once the reload has
          // settled (jupyterlab-git only awaits it to hide its refresh
          // button).
          widget.settleRefresh();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [widget, model, nonce, isBinary]);

  // Auto-close after a discard that emptied the diff. Gated on `nonce > 0` so
  // a file that opens already-empty is not closed before the user has had a
  // chance to look at it. Only the launcher host listens to `emptied`.
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

  // Per-hunk discard is only meaningful when the challenger is the working
  // tree (an unstaged change) and we are not in a three-way merge view. The
  // launcher path sets `canDiscard` explicitly (so untracked files, which
  // have no baseline to revert to, are excluded); the jupyterlab-git path
  // leaves it undefined and we derive it from the challenger's source.
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
        // The contents `fileChanged` signal the save emits drives both the
        // jupyterlab-git panel and the launcher's git status poll; we just
        // re-pull so the diff reflects the reverted hunk.
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
 * Notebook/JSON toggle mounted into whatever toolbar a host owns. Bound to
 * the widget's signals so it stays in sync with the rendered surface and
 * only appears for parseable notebooks.
 */
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

/**
 * Split/Unified toggle mounted into whatever toolbar a host owns. Mirrors
 * {@link NotebookViewModeToolbarItem}: bound to the widget's signals so it
 * stays in sync with the rendered surface and only appears while the
 * textual/code file diff is the active view.
 */
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

/**
 * The slice of `Toolbar` {@link addDiffToolbarItems} needs. Typed structurally
 * rather than as `Toolbar` because the two hosts hand us toolbars from two
 * different `@jupyterlab/ui-components` copies (jupyterlab-git bundles its
 * own), which are nominally distinct classes; only the public `addItem` is
 * common to both.
 */
interface IDiffToolbar {
  addItem(name: string, widget: Widget): boolean;
}

/**
 * Mount the diff's view-mode toolbar controls (Notebook/JSON, Split/Unified)
 * into a host-owned toolbar. Both hosts call this with the toolbar they own:
 * the launcher's `MainAreaWidget` toolbar, or the toolbar `jupyterlab-git`
 * hands the diff factory. Each control governs its own visibility off the
 * widget's signals, so they only appear when meaningful.
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
