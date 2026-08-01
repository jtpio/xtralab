import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager, WidgetTracker } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { IAskAgent } from '../askAgent/tokens';

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
 * The upstream git panel stays enabled; this plugin only gives the launcher
 * its own `xtralab:git:open-diff` command and preview/pinned-tab tracking.
 */
const diffCommandPlugin: JupyterFrontEndPlugin<void> = {
  id: GIT_DIFF_COMMAND_PLUGIN_ID,
  description:
    "The launcher dashboard's side-by-side git diff command, powered by @pierre/diffs.",
  autoStart: true,
  optional: [IThemeManager, IRenderMimeRegistry, ITranslator, IAskAgent],
  activate: (
    app: JupyterFrontEnd,
    themeManager: IThemeManager | null,
    rendermime: IRenderMimeRegistry | null,
    translator: ITranslator | null,
    askAgent: IAskAgent | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    // Track open diffs so repeated opens reveal the existing tab.
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

    // Clicking the preview tab's label pins it, mirroring how jupyterlab-git
    // pins its own preview diff tabs. Delegated in capture phase so it keeps
    // working when Lumino re-renders the tab nodes; `jp-mod-preview` is only
    // ever set by the launcher's preview diff, so the match is unambiguous.
    document.addEventListener(
      'click',
      event => {
        const target = event.target instanceof Element ? event.target : null;
        const label = target?.closest('.lm-TabBar-tabLabel') ?? null;
        if (label === null || label.closest('.jp-mod-preview') === null) {
          return;
        }
        tracker
          .find(
            widget => !widget.isDisposed && widget.id === PREVIEW_DIFF_WIDGET_ID
          )
          ?.pin();
      },
      true
    );

    registerGitCommands({
      app,
      themeManager,
      contentsManager: app.serviceManager.contents,
      rendermime,
      askAgent,
      trans,
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
 * Plugins contributed by xtralab's git integration.
 */
const plugins: JupyterFrontEndPlugin<unknown>[] = [
  diffCommandPlugin,
  diffProviderPlugin
];

export { CommandArguments, CommandIDs };

export default plugins;
