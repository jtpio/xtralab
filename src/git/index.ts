import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  IThemeManager,
  WidgetTracker
} from '@jupyterlab/apputils';
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
import { ReviewModel, type ReviewScope } from './reviewModel';
import {
  ReviewMainAreaWidget,
  ReviewPanel,
  type IReviewContext
} from './reviewWidget';
import { IFileChange, IReviewTracker } from './tokens';

const GIT_DIFF_COMMAND_PLUGIN_ID = 'xtralab:git-diff-command';
const GIT_DIFF_PREFERENCES_PLUGIN_ID = 'xtralab:git-diff-preferences';
const GIT_DIFF_TRACKER_NAMESPACE = 'xtralab-git-diff';
const GIT_REVIEW_PLUGIN_ID = 'xtralab:git-review';
const GIT_REVIEW_TRACKER_NAMESPACE = 'xtralab-git-review';

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

/**
 * The review tab: all changes of the working tree or of a branch in one
 * scrolling list of diffs.
 */
const reviewPlugin: JupyterFrontEndPlugin<IReviewTracker> = {
  id: GIT_REVIEW_PLUGIN_ID,
  description:
    'Review all uncommitted changes, or all changes of a branch, in one tab.',
  autoStart: true,
  provides: IReviewTracker,
  optional: [
    IThemeManager,
    ITranslator,
    IAskAgent,
    IDiffPreferences,
    IStateDB,
    ICommandPalette,
    ILayoutRestorer
  ],
  activate: (
    app: JupyterFrontEnd,
    themeManager: IThemeManager | null,
    translator: ITranslator | null,
    askAgent: IAskAgent | null,
    preferences: IDiffPreferences | null,
    state: IStateDB | null,
    palette: ICommandPalette | null,
    restorer: ILayoutRestorer | null
  ): IReviewTracker => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    const context: IReviewContext = {
      commands: app.commands,
      themeManager,
      askAgent,
      preferences: preferences ?? new DiffPreferences(),
      trans
    };
    const tracker = new WidgetTracker<ReviewMainAreaWidget>({
      namespace: GIT_REVIEW_TRACKER_NAMESPACE
    });

    app.commands.addCommand(CommandIDs.reviewChanges, {
      label: args =>
        args.scope === 'branch'
          ? trans.__('Review Branch Changes')
          : args.scope === 'uncommitted'
            ? trans.__('Review Uncommitted Changes')
            : trans.__('Review Changes'),
      caption: trans.__('Show all changed files and their diffs in one tab'),
      // Advertise the argument shape to agents listing commands over the MCP bridge.
      describedBy: {
        args: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['uncommitted', 'branch'],
              description:
                '"uncommitted" compares HEAD with the working tree; "branch" compares the merge-base with the base branch with the working tree. Defaults to "uncommitted", or to the current scope of an open review tab.'
            },
            base: {
              type: 'string',
              description:
                'The base branch of the "branch" scope, such as "main" or "origin/main". Defaults to origin/HEAD, then main or master.'
            },
            repoPath: {
              type: 'string',
              description:
                'Path of the repository, relative to the server root. Defaults to the server root.'
            }
          }
        }
      },
      execute: async args => {
        const repoPath = typeof args.repoPath === 'string' ? args.repoPath : '';
        const scope: ReviewScope | undefined =
          args.scope === 'branch' || args.scope === 'uncommitted'
            ? args.scope
            : undefined;
        const base = typeof args.base === 'string' ? args.base : undefined;
        const existing = tracker.find(
          widget => widget.content.model.repoPath === repoPath
        );
        if (existing !== undefined) {
          if (scope !== undefined || base !== undefined) {
            existing.content.model.setScope(
              scope ?? existing.content.model.scope,
              base
            );
          }
          app.shell.activateById(existing.id);
          return existing;
        }
        const model = new ReviewModel({
          repoPath,
          scope: scope ?? 'uncommitted',
          base: base ?? null,
          contents: app.serviceManager.contents,
          state,
          trans
        });
        const widget = new ReviewMainAreaWidget(
          new ReviewPanel(model, context)
        );
        const saveState = (): void => {
          void tracker.save(widget);
        };
        model.changed.connect(saveState);
        widget.disposed.connect(() => model.changed.disconnect(saveState));
        await tracker.add(widget);
        app.shell.add(widget, 'main');
        app.shell.activateById(widget.id);
        return widget;
      }
    });

    if (palette !== null) {
      const category = trans.__('Git');
      for (const scope of ['uncommitted', 'branch']) {
        palette.addItem({
          command: CommandIDs.reviewChanges,
          args: { scope },
          category
        });
      }
    }

    if (restorer !== null) {
      void restorer.restore(tracker, {
        command: CommandIDs.reviewChanges,
        args: widget => {
          const { model } = widget.content;
          return {
            repoPath: model.repoPath,
            scope: model.scope,
            ...(model.requestedBase !== null
              ? { base: model.requestedBase }
              : {})
          };
        },
        name: widget => widget.id
      });
    }
    return tracker;
  }
};

const plugins: JupyterFrontEndPlugin<unknown>[] = [
  diffPreferencesPlugin,
  diffCommandPlugin,
  diffProviderPlugin,
  reviewPlugin
];

export { CommandArguments, CommandIDs };

export default plugins;
