import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ICommandPalette } from '@jupyterlab/apputils';

import { IDocumentManager } from '@jupyterlab/docmanager';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { ITranslator } from '@jupyterlab/translation';

import { populateToolbar, registerCommands } from './commands';
import { XtralabFileBrowser } from './widget';

const PLUGIN_ID = 'xtralab:plugin';

/**
 * The file browser plugin. Adds a `@pierre/trees`-powered file browser to the
 * JupyterLab left sidebar.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'A path-first file browser for JupyterLab built on @pierre/trees.',
  autoStart: true,
  requires: [IDocumentManager],
  optional: [ILayoutRestorer, ISettingRegistry, ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    docManager: IDocumentManager,
    restorer: ILayoutRestorer | null,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): void => {
    const browser = new XtralabFileBrowser({
      contentsManager: app.serviceManager.contents,
      docManager,
      onOpenFile: (serverPath: string) => {
        void app.commands.execute('docmanager:open', { path: serverPath });
      }
    });
    // Ranks just under the Terminals panel in the left sidebar. The shipped
    // `layout` setting assigns the default ranks (rank only, no area pin),
    // so this browser stays movable via the "Move Widget" context menu; the
    // `rank` here is the in-code fallback for when that setting is absent.
    app.shell.add(browser, 'left', { rank: 2 });
    if (restorer) {
      restorer.add(browser, browser.id);
    }

    registerCommands({ app, browser, docManager, palette, translator });
    populateToolbar({ app, browser });

    if (settingRegistry) {
      settingRegistry.load(PLUGIN_ID).catch(reason => {
        console.error('Failed to load settings for xtralab.', reason);
      });
    }
  }
};

export default plugin;
