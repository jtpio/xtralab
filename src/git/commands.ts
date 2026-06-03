import { JupyterFrontEnd } from '@jupyterlab/application';
import { IThemeManager, MainAreaWidget } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import { ToolbarButton, launchIcon } from '@jupyterlab/ui-components';
import { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import { getTreeIcon } from '../fileBrowser/icons';
import { fileChangeToDiffModel } from './diffModel';
import {
  DIFF_WIDGET_CSS_CLASS,
  XtralabDiffWidget,
  addDiffToolbarItems
} from './diffWidget';
import { IFileChange } from './tokens';

/**
 * Command IDs exposed by the launcher's git diff path. The launcher
 * dashboard's "Changes" section drives {@link CommandIDs.openDiff} to open
 * its own diff tab, independent of `jupyterlab-git` (whose panel reaches the
 * same rendering via the providers in `diffProvider.tsx`).
 */
export namespace CommandIDs {
  export const openDiff = 'xtralab:git:open-diff';
}

/**
 * Argument shapes used by {@link CommandIDs.openDiff}. Cast to this type
 * inside the execute callback for type safety; the registry itself takes
 * `ReadonlyPartialJSONObject` because Lumino does not know about our
 * extension-specific shapes.
 */
export namespace CommandArguments {
  export interface IOpenDiff {
    repoPath: string;
    change: IFileChange;
    pin?: boolean;
  }
}

/**
 * Widget id of the single, reused preview diff tab. Opening a different file
 * while a preview is showing reuses this tab instead of stacking new ones.
 */
export const PREVIEW_DIFF_WIDGET_ID = 'xtralab:diff:preview';

/**
 * Deterministic widget id for a *pinned* diff against a particular file/group
 * pair, so promoting a preview (or reopening the same file pinned) reveals the
 * existing tab instead of opening a duplicate.
 */
export function pinnedDiffWidgetId(change: IFileChange): string {
  return `xtralab:diff:pinned:${change.group}:${change.path}`;
}

function formatTitle(change: IFileChange): string {
  const name = change.path.split('/').pop() ?? change.path;
  const groupLabel = change.group === 'staged' ? 'Staged' : 'Working';
  return `${name} (${groupLabel})`;
}

/**
 * The launcher's `MainAreaWidget` host around the shared
 * {@link XtralabDiffWidget}. It owns the launcher-only state that
 * `jupyterlab-git`'s own host provides on its side: the file-change identity
 * (used to compute pinned ids and reveal an already-open diff) and the
 * preview→pin promotion the toolbar pin button drives.
 */
export class DiffMainAreaWidget extends MainAreaWidget<XtralabDiffWidget> {
  constructor(
    options: MainAreaWidget.IOptions<XtralabDiffWidget>,
    change: IFileChange,
    pinned: boolean
  ) {
    super(options);
    this._change = change;
    this._pinned = pinned;
  }

  /** The change this diff renders; identifies the widget for reuse. */
  get change(): IFileChange {
    return this._change;
  }

  /** Whether this tab has been promoted from a preview to a permanent tab. */
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

  /** Reuse this preview tab for a different file (rebuilds the diff model). */
  setChange(repoPath: string, change: IFileChange): void {
    this._change = change;
    this.content.setModel(fileChangeToDiffModel(repoPath, change));
    this.title.label = formatTitle(change);
    this.title.caption = change.path;
    this.title.icon = getTreeIcon(change.path);
  }

  private _change: IFileChange;
  private _pinned: boolean;
  private _pinnedChanged = new Signal<this, boolean>(this);
}

interface ICreateDiffWidgetOptions {
  repoPath: string;
  change: IFileChange;
  themeManager: IThemeManager | null;
  contentsManager: Contents.IManager;
  rendermime: IRenderMimeRegistry | null;
  pinned?: boolean;
  onPinned?: (widget: DiffMainAreaWidget) => void;
}

/**
 * Build the launcher's diff tab: a {@link DiffMainAreaWidget} hosting the
 * shared {@link XtralabDiffWidget}, with the pin button and view-mode toggles
 * mounted into its toolbar and the preview/pin + auto-close wiring the
 * launcher owns.
 */
function createDiffWidget(
  options: ICreateDiffWidgetOptions
): DiffMainAreaWidget {
  const { repoPath, change, themeManager, contentsManager, rendermime } =
    options;
  const pinned = options.pinned === true;
  const content = new XtralabDiffWidget(
    fileChangeToDiffModel(repoPath, change),
    { contentsManager, rendermime, themeManager }
  );
  const widget = new DiffMainAreaWidget({ content }, change, pinned);
  widget.id = pinned ? pinnedDiffWidgetId(change) : PREVIEW_DIFF_WIDGET_ID;
  widget.title.label = formatTitle(change);
  widget.title.caption = change.path;
  widget.title.closable = true;
  widget.title.icon = getTreeIcon(change.path);
  widget.title.className = pinned ? '' : 'jp-mod-preview';
  widget.addClass(DIFF_WIDGET_CSS_CLASS);

  const onPinned = options.onPinned ?? ((): void => undefined);

  // The pin button promotes the throwaway preview tab into a permanent one
  // and hides once pinned. (jupyterlab-git's host pins via a tab-title click
  // instead, which is why only this launcher host carries the button.)
  const pinButton = new ToolbarButton({
    icon: launchIcon,
    tooltip: 'Pin tab',
    onClick: () => widget.pin()
  });
  if (widget.pinned) {
    pinButton.hide();
  }
  widget.toolbar.addItem('pin', pinButton);
  addDiffToolbarItems(widget.toolbar, content);

  // The toolbar stays visible for previews (so the pin button shows) and for
  // any diff with a relevant view-mode toggle; a pinned diff with no toggles
  // (image, binary, loading) hides it to keep the chrome quiet.
  const syncToolbarVisibility = (): void => {
    if (widget.isDisposed) {
      return;
    }
    if (!widget.pinned || content.hasNotebookView || content.fileDiffActive) {
      widget.toolbar.show();
    } else {
      widget.toolbar.hide();
    }
  };
  const onPinnedChanged = (
    _sender: DiffMainAreaWidget,
    value: boolean
  ): void => {
    if (widget.isDisposed) {
      return;
    }
    if (value) {
      pinButton.hide();
      onPinned(widget);
      if (widget.isDisposed) {
        return;
      }
      widget.title.className = '';
    }
    syncToolbarVisibility();
  };
  // Auto-close once a discard empties the diff — there is nothing left to view.
  const onEmptied = (): void => {
    if (!widget.isDisposed) {
      widget.close();
    }
  };
  content.hasNotebookViewChanged.connect(syncToolbarVisibility);
  content.fileDiffActiveChanged.connect(syncToolbarVisibility);
  content.emptied.connect(onEmptied);
  widget.pinnedChanged.connect(onPinnedChanged);
  syncToolbarVisibility();
  widget.disposed.connect(() => {
    content.hasNotebookViewChanged.disconnect(syncToolbarVisibility);
    content.fileDiffActiveChanged.disconnect(syncToolbarVisibility);
    content.emptied.disconnect(onEmptied);
    widget.pinnedChanged.disconnect(onPinnedChanged);
  });
  return widget;
}

export interface IRegisterGitCommandsOptions {
  app: JupyterFrontEnd;
  themeManager: IThemeManager | null;
  /**
   * Contents manager used by the diff widget to write hunk-discard results
   * back to the working tree.
   */
  contentsManager: Contents.IManager;
  /**
   * Rendermime registry used by the notebook diff to render outputs and
   * markdown cells with their actual mime-type renderers. May be `null` in
   * stripped-down hosts — the notebook diff falls back to a text
   * representation in that case.
   */
  rendermime: IRenderMimeRegistry | null;
  /**
   * Called for every diff widget created via the {@link CommandIDs.openDiff}
   * command, before the widget is added to the shell. Lets the plugin track
   * the widget for layout restoration and reveal-on-reuse.
   */
  trackDiff(widget: DiffMainAreaWidget): Promise<void>;
  /**
   * Look up an already-open diff widget for a given file change. Returns
   * `undefined` when none is open.
   */
  findDiff(change: IFileChange, pin?: boolean): DiffMainAreaWidget | undefined;
  onPinned(widget: DiffMainAreaWidget): void;
}

/**
 * Register the launcher's git diff command on the application command
 * registry.
 */
export function registerGitCommands(
  options: IRegisterGitCommandsOptions
): void {
  const {
    app,
    themeManager,
    contentsManager,
    rendermime,
    trackDiff,
    findDiff,
    onPinned
  } = options;
  const { commands } = app;

  commands.addCommand(CommandIDs.openDiff, {
    label: 'Open Git Diff',
    caption: 'Open a side-by-side diff for a changed file',
    execute: async (args: ReadonlyPartialJSONObject) => {
      const typed = args as unknown as CommandArguments.IOpenDiff;
      if (typed?.change === undefined) {
        return;
      }
      const pin = typed.pin === true;
      const existing = findDiff(typed.change, pin);
      if (existing !== undefined && !existing.isDisposed) {
        if (!pin) {
          existing.setChange(typed.repoPath, typed.change);
        }
        app.shell.activateById(existing.id);
        return;
      }
      const widget = createDiffWidget({
        repoPath: typed.repoPath,
        change: typed.change,
        themeManager,
        contentsManager,
        rendermime,
        pinned: pin,
        onPinned
      });
      await trackDiff(widget);
      app.shell.add(widget, 'main', { mode: 'tab-after' });
      app.shell.activateById(widget.id);
    }
  });
}
