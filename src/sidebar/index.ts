import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import type { Widget } from '@lumino/widgets';

const PLUGIN_ID = 'xtralab:sidebar';

/**
 * Each entry pairs an upstream sidebar widget id with the rank it was
 * originally added at. The ranks come from the upstream extensions —
 * `filebrowser-extension` adds the default browser at rank 100 and
 * `running-extension` adds the running panel at rank 200 — and we reuse
 * them when re-adding so the tab lands back in its usual position.
 */
interface ITarget {
  id: string;
  rank: number;
  settingKey: 'showDefaultFileBrowser' | 'showRunningSessions';
  command: string;
  label: (trans: ReturnType<ITranslator['load']>) => string;
}

const TARGETS: ITarget[] = [
  {
    id: 'filebrowser',
    rank: 100,
    settingKey: 'showDefaultFileBrowser',
    command: 'xtralab:toggle-default-filebrowser',
    label: trans => trans.__('Default File Browser')
  },
  {
    id: 'jp-running-sessions',
    rank: 200,
    settingKey: 'showRunningSessions',
    command: 'xtralab:toggle-running-sessions',
    label: trans => trans.__('Running Terminals and Kernels')
  }
];

/**
 * Lets the user toggle individual left-sidebar tabs from
 * View > Appearance > Left Sidebar. Removing a widget from a `LabShell`
 * side area is done by setting `widget.parent = null`: the StackedPanel
 * emits `widgetRemoved`, which the SideBarHandler responds to by removing
 * the matching tab. The widget instance is preserved, so we can re-add it
 * later via `labShell.add` with its original rank.
 *
 * The menu placement is contributed declaratively in
 * `schema/sidebar.json`, so this plugin only registers commands and
 * applies state — it does not touch `IMainMenu` directly.
 *
 * The preference is persisted to `xtralab:sidebar` settings so the choice
 * survives reloads.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Toggle visibility of selected sidebar tabs (default file browser, running sessions) from the View menu.',
  autoStart: true,
  requires: [ILabShell],
  optional: [ISettingRegistry, ITranslator],
  activate: async (
    app: JupyterFrontEnd,
    labShell: ILabShell,
    settingRegistry: ISettingRegistry | null,
    translator: ITranslator | null
  ): Promise<void> => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    const { commands } = app;

    // Cache widget instances so we can re-add them after `widget.parent =
    // null` has detached them from the sidebar. The widget is no longer
    // reachable through `labShell.widgets('left')` once removed, so a
    // missing cache entry would leave us unable to bring the tab back.
    const widgetCache = new Map<string, Widget>();

    const findInSidebar = (id: string): Widget | null => {
      for (const w of labShell.widgets('left')) {
        if (w.id === id) {
          return w;
        }
      }
      return null;
    };

    const captureWidget = (id: string): Widget | null => {
      const cached = widgetCache.get(id);
      if (cached && !cached.isDisposed) {
        return cached;
      }
      const found = findInSidebar(id);
      if (found) {
        widgetCache.set(id, found);
      }
      return found;
    };

    let settings: ISettingRegistry.ISettings | null = null;

    const readPreference = (target: ITarget): boolean => {
      if (!settings) {
        return true;
      }
      const value = settings.composite[target.settingKey];
      return typeof value === 'boolean' ? value : true;
    };

    const apply = (target: ITarget): void => {
      const widget = captureWidget(target.id);
      if (!widget) {
        // The upstream widget hasn't been added yet (or the extension is
        // disabled). Nothing to do — the next time `apply` runs and finds
        // it, the preference will take effect.
        return;
      }
      const present = findInSidebar(target.id) !== null;
      const wantPresent = readPreference(target);
      if (wantPresent && !present) {
        labShell.add(widget, 'left', { rank: target.rank });
      } else if (!wantPresent && present) {
        // Setting `parent = null` triggers SideBarHandler's
        // `_onWidgetRemoved`, which strips the tab while leaving the
        // widget instance alive for a later re-add.
        widget.parent = null;
      }
    };

    const applyAll = (): void => {
      for (const target of TARGETS) {
        apply(target);
      }
    };

    for (const target of TARGETS) {
      commands.addCommand(target.command, {
        label: target.label(trans),
        isToggled: () => readPreference(target),
        execute: async () => {
          const next = !readPreference(target);
          if (settings) {
            try {
              await settings.set(target.settingKey, next);
              // `settings.changed` will fire and drive `apply` + the
              // command-state refresh. Returning here keeps the toggle's
              // single source of truth in the settings registry.
              return;
            } catch (reason) {
              console.error(
                `xtralab: failed to persist ${target.settingKey}`,
                reason
              );
            }
          }
          // No settings registry available (or the write failed): fall
          // back to applying the change in-memory so the toggle still
          // works for the current session.
          apply(target);
          commands.notifyCommandChanged(target.command);
        }
      });
    }

    if (settingRegistry) {
      try {
        settings = await settingRegistry.load(PLUGIN_ID);
        settings.changed.connect(() => {
          applyAll();
          for (const target of TARGETS) {
            commands.notifyCommandChanged(target.command);
          }
        });
      } catch (reason) {
        console.error('xtralab: failed to load sidebar settings', reason);
      }
    }

    void app.restored.then(() => {
      // Capture references first so a hidden-on-startup widget is still
      // recoverable later. `apply` would also do the lookup, but only on
      // the targets that need to stay visible — by capturing every target
      // here we keep the cache populated for both directions of the
      // toggle.
      for (const target of TARGETS) {
        captureWidget(target.id);
      }
      applyAll();
    });
  }
};

export default plugin;
