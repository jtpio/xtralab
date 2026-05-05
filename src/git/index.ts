import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  ICommandPalette,
  IThemeManager,
  WidgetTracker,
  showDialog,
  showErrorMessage
} from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import { ReadonlyPartialJSONObject } from '@lumino/coreutils';

import { CommandArguments, CommandIDs, registerGitCommands } from './commands';
import {
  DiffContentWidget,
  PREVIEW_DIFF_WIDGET_ID,
  pinnedDiffWidgetId
} from './diffWidget';
import type { MainAreaWidget } from '@jupyterlab/apputils';
import { GitPanel } from './panel';
import { IFileChange } from './tokens';

const GIT_PLUGIN_ID = 'xtralab:git';
const GIT_DIFF_TRACKER_NAMESPACE = 'xtralab-git-diff';

/**
 * The git plugin. Adds a VS Code-style "Source Control" panel to the
 * JupyterLab left sidebar and opens file diffs in the main area when the
 * user clicks an entry in the panel. Backed by the `jupyterlab_git` server
 * extension's REST API; the bundled `@jupyterlab/git` frontend is disabled
 * via `package.json`'s `jupyterlab.disabledExtensions` so the two panels do
 * not coexist.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: GIT_PLUGIN_ID,
  description:
    'A VS Code-style git changes panel and diff viewer powered by jupyterlab-git and @pierre/diffs.',
  autoStart: true,
  optional: [
    ILayoutRestorer,
    IThemeManager,
    ICommandPalette,
    IRenderMimeRegistry
  ],
  activate: (
    app: JupyterFrontEnd,
    restorer: ILayoutRestorer | null,
    themeManager: IThemeManager | null,
    commandPalette: ICommandPalette | null,
    rendermime: IRenderMimeRegistry | null
  ): void => {
    // Match the panel's repo path: empty string means "use the JupyterLab
    // server's root and let git resolve the enclosing repo".
    const repoPath = '';

    // Track open diff widgets so the layout restorer can recreate them on
    // reload, and so the openDiff handler can reveal an already-open diff
    // for the same file instead of creating a duplicate.
    const tracker = new WidgetTracker<MainAreaWidget<DiffContentWidget>>({
      namespace: GIT_DIFF_TRACKER_NAMESPACE
    });

    const findDiff = (
      change: IFileChange,
      pin = false
    ): MainAreaWidget<DiffContentWidget> | undefined => {
      const id = pin ? pinnedDiffWidgetId(change) : PREVIEW_DIFF_WIDGET_ID;
      const existing = tracker.find(
        widget => !widget.isDisposed && widget.id === id
      );
      return existing ?? undefined;
    };

    const panel = new GitPanel({
      openDiff: (change, options) => {
        const args: CommandArguments.IOpenDiff = { repoPath, change };
        if (options?.pin === true) {
          args.pin = true;
        }
        void app.commands.execute(
          CommandIDs.openDiff,
          args as unknown as ReadonlyPartialJSONObject
        );
      },
      confirm: async (title, body, accept) => {
        const result = await showDialog({
          title,
          body,
          buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: accept })]
        });
        return result.button.accept === true;
      },
      showError: showErrorMessage
    });

    app.shell.add(panel, 'left', { rank: 60 });
    if (restorer !== null) {
      restorer.add(panel, panel.id);
    }

    registerGitCommands({
      app,
      panel,
      themeManager,
      commandPalette,
      contentsManager: app.serviceManager.contents,
      rendermime,
      onChanged: () => panel.refresh(),
      trackDiff: widget => tracker.add(widget),
      onPinned: current => {
        const existing = findDiff(current.content.change, true);
        if (
          existing !== undefined &&
          existing !== current &&
          !existing.isDisposed
        ) {
          app.shell.activateById(existing.id);
          current.close();
          return;
        }
        current.id = pinnedDiffWidgetId(current.content.change);
        current.title.className = '';
        app.shell.activateById(current.id);
      },
      findDiff
    });
  }
};

export default plugin;
