import { JupyterFrontEnd } from '@jupyterlab/application';
import { IThemeManager } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import { ReadonlyPartialJSONObject } from '@lumino/coreutils';

import {
  createGitDiffWidget,
  diffWidgetId,
  updateGitDiffWidget
} from './diffWidget';
import { IFileChange } from './tokens';

/**
 * Command IDs exposed by the launcher's git diff path. The launcher
 * dashboard's "Changes" section drives {@link CommandIDs.openDiff} to open
 * its own diff tab — this path is intentionally kept independent of
 * `jupyterlab-git` (the `jupyterlab-git` panel reaches the same diff
 * rendering through the providers registered in `diffProvider.tsx`).
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

export interface IRegisterGitCommandsOptions {
  app: JupyterFrontEnd;
  themeManager: IThemeManager | null;
  /**
   * Contents manager used by the diff widget to write hunk-discard
   * results back to the working tree.
   */
  contentsManager: Contents.IManager;
  /**
   * Rendermime registry used by the notebook diff to render outputs and
   * markdown cells with their actual mime-type renderers (images as
   * images, HTML as HTML, etc.). May be `null` in stripped-down hosts —
   * the notebook diff falls back to a text representation in that case.
   */
  rendermime: IRenderMimeRegistry | null;
  /**
   * Called whenever the diff widget mutates the working tree (e.g. after
   * a hunk discard). The launcher dashboard polls git status on its own
   * cadence and `jupyterlab-git`'s panel auto-refreshes on the contents
   * `fileChanged` signal the save emits, so this is a hook for any extra
   * bookkeeping rather than a required refresh.
   */
  onChanged: () => void;
  /**
   * Called for every diff widget created via the {@link CommandIDs.openDiff}
   * command, before the widget is added to the shell. Lets the plugin track
   * the widget for layout restoration and reveal-on-reuse.
   */
  trackDiff(widget: ReturnType<typeof createGitDiffWidget>): Promise<void>;
  /**
   * Look up an already-open diff widget for a given file change. Returns
   * `undefined` when none is open.
   */
  findDiff(
    change: IFileChange,
    pin?: boolean
  ): ReturnType<typeof createGitDiffWidget> | undefined;
  onPinned(widget: ReturnType<typeof createGitDiffWidget>): void;
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
    onChanged,
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
          updateGitDiffWidget(existing, typed.change);
        }
        app.shell.activateById(existing.id);
        return;
      }
      const widget = createGitDiffWidget({
        repoPath: typed.repoPath,
        change: typed.change,
        themeManager,
        contentsManager,
        rendermime,
        onChanged,
        pinned: pin,
        onPinned
      });
      await trackDiff(widget);
      app.shell.add(widget, 'main', { mode: 'tab-after' });
      app.shell.activateById(widget.id);
    }
  });
}

export { diffWidgetId };
