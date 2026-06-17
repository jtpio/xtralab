import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

const PLUGIN_ID = 'xtralab:search-replace';

const COMMAND_ID = 'xtralab:activate-search-replace';

/**
 * Widget id of the panel contributed by `jupyterlab-search-replace`. The
 * extension adds it to the left sidebar but registers no command of its own,
 * so there is nothing to bind a shortcut to out of the box — this plugin adds
 * the missing command.
 */
const SEARCH_REPLACE_WIDGET_ID = 'jp-search-replace';

/**
 * Bind Accel+Shift+F (Cmd+Shift+F on macOS, Ctrl+Shift+F elsewhere) to the
 * project-wide Search and Replace panel, matching the equivalent shortcut in
 * editors like VS Code.
 *
 * Two pieces are needed because that chord is already taken: JupyterLab core
 * binds Accel+Shift+F to `filebrowser:toggle-main`.
 *
 * 1. The chord is freed declaratively. `SettingRegistry.reconcileShortcuts`
 *    keys collisions and disables on (keys, selector) — not on command — so the
 *    `@jupyterlab/shortcuts-extension:shortcuts` override in
 *    `default_setting_overrides.d/00-xtralab.json` disables the file-browser
 *    binding. The file browser stays reachable from its sidebar tab and the
 *    View menu; only the keyboard shortcut moves.
 *
 * 2. The new binding is added imperatively below rather than as another shipped
 *    default. A `disabled` default and a re-binding default land on the same
 *    (keys, selector) slot, and the disable suppresses every default on that
 *    slot — including the re-binding. `commands.addKeyBinding` runs outside the
 *    reconcile pass, so it is unaffected and wins cleanly once the file-browser
 *    binding is gone.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Activate the Search and Replace panel with Accel+Shift+F (Cmd/Ctrl+Shift+F).',
  autoStart: true,
  requires: [ILabShell],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    labShell: ILabShell,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    const { commands } = app;

    commands.addCommand(COMMAND_ID, {
      label: trans.__('Search and Replace'),
      caption: trans.__('Show the Search and Replace panel'),
      execute: () => {
        // `activateById` expands the left sidebar when collapsed, selects the
        // tab, and the widget focuses its search input from `onAfterShow`, so
        // the user can start typing a query immediately. It no-ops if
        // `jupyterlab-search-replace` is unavailable.
        labShell.activateById(SEARCH_REPLACE_WIDGET_ID);
      }
    });

    commands.addKeyBinding({
      command: COMMAND_ID,
      keys: ['Accel Shift F'],
      selector: 'body'
    });

    if (palette) {
      palette.addItem({
        command: COMMAND_ID,
        category: trans.__('File Operations')
      });
    }
  }
};

export default plugin;
