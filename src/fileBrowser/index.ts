import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ICommandPalette, IMovableSectionRegistry } from '@jupyterlab/apputils';

import { IDocumentManager } from '@jupyterlab/docmanager';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { populateToolbar, registerCommands } from './commands';
import { FILE_BROWSER_ID, XtralabFileBrowser } from './widget';

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
  optional: [
    ILayoutRestorer,
    ISettingRegistry,
    ICommandPalette,
    ITranslator,
    IMovableSectionRegistry
  ],
  activate: (
    app: JupyterFrontEnd,
    docManager: IDocumentManager,
    restorer: ILayoutRestorer | null,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null,
    movableSections: IMovableSectionRegistry | null
  ): void => {
    const browser = new XtralabFileBrowser({
      contentsManager: app.serviceManager.contents,
      docManager,
      onOpenFile: (serverPath: string) => {
        void app.commands.execute('docmanager:open', { path: serverPath });
      },
      translator: translator ?? undefined
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

    if (movableSections) {
      const label = (translator ?? nullTranslator)
        .load('jupyterlab')
        .__('Files');
      movableSections.registerSource(FILE_BROWSER_ID, label, browser);
      movableSections.registerTarget(FILE_BROWSER_ID, label, browser);

      // Only a user move should switch the sidebar, not the startup restoration.
      let settled = false;
      void app.restored.then(() => {
        settled = true;
      });
      browser.contentChanged.connect(() => {
        if (browser.isEmpty) {
          if (browser.parent) {
            browser.parent = null;
          }
        } else if (!browser.parent) {
          app.shell.add(browser, 'left', { rank: 2 });
          if (settled) {
            app.shell.activateById(browser.id);
          }
        }
      });
      browser.announceSections();
    }

    if (settingRegistry) {
      settingRegistry.load(PLUGIN_ID).catch(reason => {
        console.error('Failed to load settings for xtralab.', reason);
      });
    }
  }
};

export default plugin;
