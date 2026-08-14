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
 * `rank` is the fallback used when re-adding a hidden tab; the shipped
 * `layout` setting normally wins because `LabShell.add` merges its
 * per-widget options over the ones passed in.
 */
interface ITarget {
  /**
   * The shell widget id of the sidebar tab.
   */
  id: string;
  /**
   * The sidebar rank used when re-adding the hidden tab.
   */
  rank: number;
  /**
   * The boolean plugin setting controlling the tab's visibility.
   */
  settingKey:
    | 'showTerminals'
    | 'showFileBrowser'
    | 'showGitPanel'
    | 'showDefaultFileBrowser'
    | 'showRunningSessions'
    | 'showSearchReplace';
  /**
   * The id of the toggle command registered for the tab.
   */
  command: string;
  /**
   * The localized label of the toggle command.
   */
  label: (trans: ReturnType<ITranslator['load']>) => string;
}

const TARGETS: ITarget[] = [
  {
    id: 'xtralab-running-terminals',
    rank: 1,
    settingKey: 'showTerminals',
    command: 'xtralab:toggle-terminals',
    label: trans => trans.__('Terminals')
  },
  {
    id: 'xtralab:file-browser',
    rank: 2,
    settingKey: 'showFileBrowser',
    command: 'xtralab:toggle-file-browser',
    label: trans => trans.__('File Browser')
  },
  {
    id: 'jp-git-sessions',
    rank: 200,
    settingKey: 'showGitPanel',
    command: 'xtralab:toggle-git-panel',
    label: trans => trans.__('Git')
  },
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
  },
  {
    id: 'jp-search-replace',
    rank: 900,
    settingKey: 'showSearchReplace',
    command: 'xtralab:toggle-search-replace',
    label: trans => trans.__('Search and Replace')
  }
];

/**
 * Toggles individual sidebar tabs from View > Appearance > Sidebars. Hiding
 * detaches the widget while keeping the instance for a later re-add; which
 * side it came from is only tracked in-memory, so after a reload a re-shown
 * tab lands on the left. Menu placement is declared in schema/sidebar.json.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Toggle visibility of individual sidebar tabs from the View menu.',
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

    // Detached widgets are unreachable via `labShell.widgets(...)`; keep
    // instances here so hidden tabs can be re-added.
    const widgetCache = new Map<string, Widget>();

    const hiddenFrom = new Map<string, 'left' | 'right'>();

    const findInSidebars = (
      id: string
    ): { widget: Widget; area: 'left' | 'right' } | null => {
      for (const area of ['left', 'right'] as const) {
        for (const widget of labShell.widgets(area)) {
          if (widget.id === id) {
            return { widget, area };
          }
        }
      }
      return null;
    };

    const locate = (id: string): 'left' | 'right' | null =>
      findInSidebars(id)?.area ?? null;

    const captureWidget = (id: string): Widget | null => {
      const cached = widgetCache.get(id);
      if (cached && !cached.isDisposed) {
        return cached;
      }
      const found = findInSidebars(id);
      if (found) {
        widgetCache.set(id, found.widget);
      }
      return found?.widget ?? null;
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
        return;
      }
      const area = locate(target.id);
      if (!area && widget.parent !== null) {
        // Attached outside the sidebars — leave it alone.
        return;
      }
      const wantPresent = readPreference(target);
      if (wantPresent && !area) {
        labShell.add(widget, hiddenFrom.get(target.id) ?? 'left', {
          rank: target.rank
        });
        hiddenFrom.delete(target.id);
      } else if (!wantPresent && area) {
        hiddenFrom.set(target.id, area);
        // Detaching makes the SideBarHandler remove the tab while the
        // widget instance stays alive for a later re-add.
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
        isVisible: () => {
          // List only tabs this plugin can manage: in a sidebar, or
          // hidden by this plugin (`parent === null`).
          const widget = captureWidget(target.id);
          return (
            widget !== null &&
            (widget.parent === null || locate(target.id) !== null)
          );
        },
        execute: async () => {
          const next = !readPreference(target);
          if (settings) {
            try {
              await settings.set(target.settingKey, next);
              // `settings.changed` drives `apply` and the state refresh.
              return;
            } catch (reason) {
              console.error(
                `xtralab: failed to persist ${target.settingKey}`,
                reason
              );
            }
          }
          // No settings (or the write failed): apply in-memory for this session.
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
      // Capture every widget before applying, so tabs hidden on startup
      // stay recoverable.
      for (const target of TARGETS) {
        captureWidget(target.id);
      }
      applyAll();
    });
  }
};

export default plugin;
