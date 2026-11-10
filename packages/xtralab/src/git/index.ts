import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager, WidgetTracker } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
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
import { DiffPreferences, IDiffPreferences } from './diffPreferences';
import diffProviderPlugin from './diffProvider';
import { IFileChange } from './tokens';

const GIT_DIFF_COMMAND_PLUGIN_ID = 'xtralab:git-diff-command';
const GIT_DIFF_PREFERENCES_PLUGIN_ID = 'xtralab:git-diff-preferences';
const GIT_DIFF_TRACKER_NAMESPACE = 'xtralab-git-diff';

/**
 * The display choices shared by the launcher diff and the Git panel diff.
 */
const diffPreferencesPlugin: JupyterFrontEndPlugin<IDiffPreferences> = {
  id: GIT_DIFF_PREFERENCES_PLUGIN_ID,
  description:
    'Keeps the git diff display choices in the settings and the state database.',
  autoStart: true,
  provides: IDiffPreferences,
  optional: [ISettingRegistry, IStateDB],
  activate: (
    app: JupyterFrontEnd,
    settingRegistry: ISettingRegistry | null,
    state: IStateDB | null
  ): IDiffPreferences => {
    const preferences = new DiffPreferences();
    if (settingRegistry !== null) {
      settingRegistry
        .load(GIT_DIFF_PREFERENCES_PLUGIN_ID)
        .then(settings => preferences.connectSettings(settings))
        .catch(reason => {
          console.error(
            `xtralab: failed to load settings for ${GIT_DIFF_PREFERENCES_PLUGIN_ID}`,
            reason
          );
        });
    }
    if (state !== null) {
      preferences.connectState(state).catch(reason => {
        console.error('xtralab: failed to restore the diff split', reason);
      });
    }
    return preferences;
  }
};

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
  optional: [
    IThemeManager,
    IRenderMimeRegistry,
    ITranslator,
    IAskAgent,
    IDiffPreferences
  ],
  activate: (
    app: JupyterFrontEnd,
    themeManager: IThemeManager | null,
    rendermime: IRenderMimeRegistry | null,
    translator: ITranslator | null,
    askAgent: IAskAgent | null,
    preferences: IDiffPreferences | null
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
      preferences: preferences ?? new DiffPreferences(),
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
  diffPreferencesPlugin,
  diffCommandPlugin,
  diffProviderPlugin
];

export { CommandArguments, CommandIDs };

export default plugins;
