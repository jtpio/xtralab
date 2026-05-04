import { JupyterFrontEnd } from '@jupyterlab/application';
import { ICommandPalette, IThemeManager } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import { refreshIcon } from '@jupyterlab/ui-components';
import { ReadonlyPartialJSONObject } from '@lumino/coreutils';

import { createGitDiffWidget, diffWidgetId } from './diffWidget';
import { GitPanel } from './panel';
import { IFileChange } from './tokens';

/**
 * Command IDs exposed by the git plugin. Both are registered in
 * {@link registerGitCommands} so other extensions, the command palette and
 * keybindings can drive the panel without going through the React internals.
 */
export namespace CommandIDs {
  export const refresh = 'xtralab:git:refresh';
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
  }
}

export interface IRegisterGitCommandsOptions {
  app: JupyterFrontEnd;
  panel: GitPanel;
  themeManager: IThemeManager | null;
  commandPalette: ICommandPalette | null;
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
   * a hunk discard) so the plugin can refresh the changes panel.
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
    change: IFileChange
  ): ReturnType<typeof createGitDiffWidget> | undefined;
}

/**
 * Register the git commands on the application command registry. Returns
 * a disposer that clears the command palette items the registration created
 * (the commands themselves stay registered for the lifetime of the plugin).
 */
export function registerGitCommands(
  options: IRegisterGitCommandsOptions
): () => void {
  const {
    app,
    panel,
    themeManager,
    commandPalette,
    contentsManager,
    rendermime,
    onChanged,
    trackDiff,
    findDiff
  } = options;
  const { commands } = app;

  commands.addCommand(CommandIDs.refresh, {
    label: 'Refresh Git Changes',
    caption: 'Refresh the git changes panel',
    icon: refreshIcon,
    execute: () => {
      panel.refresh();
    }
  });

  commands.addCommand(CommandIDs.openDiff, {
    label: 'Open Git Diff',
    caption: 'Open a side-by-side diff for a changed file',
    execute: async (args: ReadonlyPartialJSONObject) => {
      const typed = args as unknown as CommandArguments.IOpenDiff;
      if (typed?.change === undefined) {
        return;
      }
      const existing = findDiff(typed.change);
      if (existing !== undefined && !existing.isDisposed) {
        app.shell.activateById(existing.id);
        return;
      }
      const widget = createGitDiffWidget({
        repoPath: typed.repoPath,
        change: typed.change,
        themeManager,
        contentsManager,
        rendermime,
        onChanged
      });
      await trackDiff(widget);
      app.shell.add(widget, 'main', { mode: 'tab-after' });
      app.shell.activateById(widget.id);
    }
  });

  const paletteItems = commandPalette
    ? [
        commandPalette.addItem({
          command: CommandIDs.refresh,
          category: 'Git'
        })
      ]
    : [];

  return () => {
    paletteItems.forEach(item => item.dispose());
  };
}

export { diffWidgetId };
