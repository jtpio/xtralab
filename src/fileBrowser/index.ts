import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { IDocumentManager } from '@jupyterlab/docmanager';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

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
  optional: [ILayoutRestorer, ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    docManager: IDocumentManager,
    restorer: ILayoutRestorer | null,
    settingRegistry: ISettingRegistry | null
  ): void => {
    const browser = new XtralabFileBrowser({
      contentsManager: app.serviceManager.contents,
      docManager,
      onOpenFile: (serverPath: string) => {
        void app.commands.execute('docmanager:open', { path: serverPath });
      }
    });
    app.shell.add(browser, 'left', { rank: 700 });
    if (restorer) {
      restorer.add(browser, browser.id);
    }

    registerCommands({ app, browser });
    populateToolbar({ app, browser });

    if (settingRegistry) {
      settingRegistry.load(PLUGIN_ID).catch(reason => {
        console.error('Failed to load settings for xtralab.', reason);
      });
    }
  }
};

export default plugin;
