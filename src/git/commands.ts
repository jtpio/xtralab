import { JupyterFrontEnd } from '@jupyterlab/application';
import { IThemeManager, MainAreaWidget } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import type { TranslationBundle } from '@jupyterlab/translation';
import { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import type { IAskAgent } from '../askAgent/tokens';
import { getTreeIcon } from '../fileBrowser/icons';
import { fileChangeToDiffModel } from './diffModel';
import {
  DIFF_WIDGET_CSS_CLASS,
  XtralabDiffWidget,
  addDiffToolbarItems
} from './diffWidget';
import { IFileChange } from './tokens';

/**
 * Command IDs exposed by the launcher's git diff path.
 */
export namespace CommandIDs {
  export const openDiff = 'xtralab:git:open-diff';
}

/**
 * Argument shapes used by {@link CommandIDs.openDiff}.
 */
export namespace CommandArguments {
  export interface IOpenDiff {
    repoPath: string;
    change: IFileChange;
    pin?: boolean;
  }
}

/**
 * Widget id of the single, reused preview diff tab.
 */
export const PREVIEW_DIFF_WIDGET_ID = 'xtralab:diff:preview';

/**
 * Deterministic widget id for a pinned file/group pair.
 */
export function pinnedDiffWidgetId(change: IFileChange): string {
  return `xtralab:diff:pinned:${change.group}:${change.path}`;
}

function formatTitle(change: IFileChange, trans: TranslationBundle): string {
  const name = change.path.split('/').pop() ?? change.path;
  const groupLabel =
    change.group === 'staged' ? trans.__('Staged') : trans.__('Working');
  return `${name} (${groupLabel})`;
}

/**
 * Launcher-owned host for a shared diff widget.
 */
export class DiffMainAreaWidget extends MainAreaWidget<XtralabDiffWidget> {
  constructor(
    options: MainAreaWidget.IOptions<XtralabDiffWidget>,
    change: IFileChange,
    pinned: boolean,
    trans: TranslationBundle
  ) {
    super(options);
    this._change = change;
    this._pinned = pinned;
    this._trans = trans;
  }

  get change(): IFileChange {
    return this._change;
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

  setChange(repoPath: string, change: IFileChange): void {
    this._change = change;
    this.content.setModel(fileChangeToDiffModel(repoPath, change));
    this.title.label = formatTitle(change, this._trans);
    this.title.caption = change.path;
    this.title.icon = getTreeIcon(change.path);
  }

  private _change: IFileChange;
  private _pinned: boolean;
  private _trans: TranslationBundle;
  private _pinnedChanged = new Signal<this, boolean>(this);
}

interface ICreateDiffWidgetOptions {
  repoPath: string;
  change: IFileChange;
  themeManager: IThemeManager | null;
  contentsManager: Contents.IManager;
  rendermime: IRenderMimeRegistry | null;
  askAgent: IAskAgent | null;
  trans: TranslationBundle;
  pinned?: boolean;
  onPinned?: (widget: DiffMainAreaWidget) => void;
}

/**
 * Build the launcher's diff tab around the shared diff widget.
 */
function createDiffWidget(
  options: ICreateDiffWidgetOptions
): DiffMainAreaWidget {
  const {
    repoPath,
    change,
    themeManager,
    contentsManager,
    rendermime,
    askAgent,
    trans
  } = options;
  const pinned = options.pinned === true;
  const content = new XtralabDiffWidget(
    fileChangeToDiffModel(repoPath, change),
    { contentsManager, rendermime, themeManager, askAgent, trans }
  );
  const widget = new DiffMainAreaWidget({ content }, change, pinned, trans);
  widget.id = pinned ? pinnedDiffWidgetId(change) : PREVIEW_DIFF_WIDGET_ID;
  widget.title.label = formatTitle(change, trans);
  widget.title.caption = change.path;
  widget.title.closable = true;
  widget.title.icon = getTreeIcon(change.path);
  widget.title.className = pinned ? '' : 'jp-mod-preview';
  widget.addClass(DIFF_WIDGET_CSS_CLASS);

  const onPinned = options.onPinned ?? ((): void => undefined);

  addDiffToolbarItems(widget.toolbar, content);

  // Keep chrome visible only while there is a relevant toolbar control.
  const syncToolbarVisibility = (): void => {
    if (widget.isDisposed) {
      return;
    }
    if (content.hasNotebookView || content.fileDiffActive) {
      widget.toolbar.show();
    } else {
      widget.toolbar.hide();
    }
  };
  const onPinnedChanged = (
    sender: DiffMainAreaWidget,
    value: boolean
  ): void => {
    if (widget.isDisposed || !value) {
      return;
    }
    onPinned(widget);
    if (widget.isDisposed) {
      return;
    }
    widget.title.className = '';
  };
  // Auto-close once a discard leaves nothing to show.
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

interface IRegisterGitCommandsOptions {
  app: JupyterFrontEnd;
  themeManager: IThemeManager | null;
  /**
   * Contents manager used to write hunk-discard results.
   */
  contentsManager: Contents.IManager;
  /**
   * Rendermime registry used by notebook diffs; may be `null`.
   */
  rendermime: IRenderMimeRegistry | null;
  /**
   * Ask-agent popup for prompting an agent about diff lines; may be `null`.
   */
  askAgent: IAskAgent | null;
  /**
   * Translation bundle for user-facing strings.
   */
  trans: TranslationBundle;
  /**
   * Track newly created diff widgets before they are added to the shell.
   */
  trackDiff(widget: DiffMainAreaWidget): Promise<void>;
  /**
   * Look up an already-open diff widget for a file change.
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
    askAgent,
    trans,
    trackDiff,
    findDiff,
    onPinned
  } = options;
  const { commands } = app;

  commands.addCommand(CommandIDs.openDiff, {
    label: trans.__('Open Git Diff'),
    caption: trans.__('Open a side-by-side diff for a changed file'),
    execute: async (args: ReadonlyPartialJSONObject) => {
      const typed = args as unknown as CommandArguments.IOpenDiff;
      if (typed?.change === undefined) {
        return;
      }
      const pin = typed.pin === true;
      // Reveal an existing pinned tab for this change instead of opening a
      // duplicate, as jupyterlab-git does.
      const pinned = findDiff(typed.change, true);
      if (pinned !== undefined && !pinned.isDisposed) {
        app.shell.activateById(pinned.id);
        return;
      }
      if (!pin) {
        const preview = findDiff(typed.change);
        if (preview !== undefined && !preview.isDisposed) {
          preview.setChange(typed.repoPath, typed.change);
          app.shell.activateById(preview.id);
          return;
        }
      }
      const widget = createDiffWidget({
        repoPath: typed.repoPath,
        change: typed.change,
        themeManager,
        contentsManager,
        rendermime,
        askAgent,
        trans,
        pinned: pin,
        onPinned
      });
      await trackDiff(widget);
      app.shell.add(widget, 'main', { mode: 'tab-after' });
      app.shell.activateById(widget.id);
    }
  });
}
