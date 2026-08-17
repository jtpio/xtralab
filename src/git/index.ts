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
 * The launcher's git diff command plugin. The upstream git panel stays
 * enabled; this only adds `xtralab:git:open-diff` and preview/pinned-tab
 * tracking.
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

const plugins: JupyterFrontEndPlugin<unknown>[] = [
  diffCommandPlugin,
  diffProviderPlugin
];

export { CommandArguments, CommandIDs };

export default plugins;
