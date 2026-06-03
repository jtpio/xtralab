import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager, WidgetTracker } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import {
  CommandArguments,
  CommandIDs,
  DiffMainAreaWidget,
  PREVIEW_DIFF_WIDGET_ID,
  pinnedDiffWidgetId,
  registerGitCommands
} from './commands';
import diffProviderPlugin from './diffProvider';
import { IFileChange } from './tokens';

const GIT_DIFF_COMMAND_PLUGIN_ID = 'xtralab:git-diff-command';
const GIT_DIFF_TRACKER_NAMESPACE = 'xtralab-git-diff';

/**
 * The launcher's git diff command plugin.
 *
 * The `@jupyterlab/git` frontend stays enabled (only its diff plugins are
 * swapped — see `diffProvider.tsx`), so the upstream git panel is what the
 * user sees in the sidebar. This plugin is the launcher dashboard's
 * independent diff path: the `xtralab:git:open-diff` command the dashboard's
 * "Changes" section calls, plus a tracker so reopening a diff reveals the
 * existing tab and the preview/pin behavior keeps working.
 */
const diffCommandPlugin: JupyterFrontEndPlugin<void> = {
  id: GIT_DIFF_COMMAND_PLUGIN_ID,
  description:
    "The launcher dashboard's side-by-side git diff command, powered by @pierre/diffs.",
  autoStart: true,
  optional: [IThemeManager, IRenderMimeRegistry],
  activate: (
    app: JupyterFrontEnd,
    themeManager: IThemeManager | null,
    rendermime: IRenderMimeRegistry | null
  ): void => {
    // Track open diff widgets so the openDiff handler can reveal an
    // already-open diff for the same file instead of creating a duplicate
    // (and so a promoted preview can find its pinned twin).
    const tracker = new WidgetTracker<DiffMainAreaWidget>({
      namespace: GIT_DIFF_TRACKER_NAMESPACE
    });

    const findDiff = (
      change: IFileChange,
      pin = false
    ): DiffMainAreaWidget | undefined => {
      const id = pin ? pinnedDiffWidgetId(change) : PREVIEW_DIFF_WIDGET_ID;
      const existing = tracker.find(
        widget => !widget.isDisposed && widget.id === id
      );
      return existing ?? undefined;
    };

    registerGitCommands({
      app,
      themeManager,
      contentsManager: app.serviceManager.contents,
      rendermime,
      trackDiff: widget => tracker.add(widget),
      onPinned: current => {
        const existing = findDiff(current.change, true);
        if (
          existing !== undefined &&
          existing !== current &&
          !existing.isDisposed
        ) {
          app.shell.activateById(existing.id);
          current.close();
          return;
        }
        current.id = pinnedDiffWidgetId(current.change);
        current.title.className = '';
        app.shell.activateById(current.id);
      },
      findDiff
    });
  }
};

/**
 * Every plugin contributed by xtralab's git integration:
 *
 *   1. {@link diffCommandPlugin} — the launcher's `xtralab:git:open-diff`.
 *   2. `diffProviderPlugin` — registers the `@pierre/diffs` rendering as
 *      jupyterlab-git's diff providers (replacing its disabled
 *      notebook/text diff plugins).
 */
const plugins: JupyterFrontEndPlugin<unknown>[] = [
  diffCommandPlugin,
  diffProviderPlugin
];

export { CommandArguments, CommandIDs };

export default plugins;
