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
 * Widget id of the `jupyterlab-search-replace` left-sidebar panel; the
 * extension registers no command of its own to bind a shortcut to.
 */
const SEARCH_REPLACE_WIDGET_ID = 'jp-search-replace';

/**
 * Bind Accel+Shift+F to the Search and Replace panel (VS Code parity). Core
 * binds the chord to `filebrowser:toggle-main`; a `default_setting_overrides.d`
 * override disables it. The re-binding is imperative: `reconcileShortcuts` keys
 * on (keys, selector), so the disable would suppress a shipped default too.
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
        // The widget focuses its search input from `onAfterShow`; no-ops if
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
