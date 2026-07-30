import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, ICommandPalette, showDialog } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import * as React from 'react';

const PLUGIN_ID = 'xtralab:about';

/**
 * Upstream command id. Reusing it keeps the Help menu entry (contributed by
 * `schema/about.json` at the same rank as upstream), the command palette
 * muscle memory, and any external caller of `help:about` working.
 */
const CommandIDs = {
  about: 'help:about'
};

const REPO_URL = 'https://github.com/jtpio/xtralab';

/**
 * An "About xtralab" dialog replacing the stock "About JupyterLab" one.
 *
 * The upstream `@jupyterlab/help-extension:about` plugin is disabled via
 * `jupyterlab.disabledExtensions` (package.json), which removes both its
 * `help:about` command and its Help menu contribution; this plugin registers
 * the same command id and restores the menu entry through its own schema.
 * The dialog leads with the xtralab version and keeps the underlying
 * JupyterLab version visible underneath.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Show an About dialog with the xtralab and JupyterLab versions.',
  autoStart: true,
  requires: [ISettingRegistry],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    settingRegistry: ISettingRegistry,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): void => {
    const { commands } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    commands.addCommand(CommandIDs.about, {
      label: trans.__('About %1', 'xtralab'),
      describedBy: {
        args: {
          type: 'object',
          properties: {}
        }
      },
      execute: async () => {
        // The settings payload carries the version of the installed
        // labextension (read server-side from its package.json), which is
        // the release actually running — the page config only knows the
        // JupyterLab version. 'N/A' is jupyterlab_server's not-found value.
        const version = await settingRegistry
          .load(PLUGIN_ID)
          .then(settings =>
            settings.version === 'N/A' ? '' : settings.version
          )
          .catch(() => '');

        const title = (
          <span className="jp-xtralab-About-header">
            <span className="jp-xtralab-About-wordmark">xtralab</span>
            {version ? (
              <span className="jp-xtralab-About-version">
                {trans.__('Version %1', version)}
              </span>
            ) : null}
          </span>
        );

        const body = (
          <div className="jp-xtralab-About-body">
            <span className="jp-xtralab-About-basedOn">
              {trans.__('Based on JupyterLab %1', app.version)}
            </span>
            <span className="jp-xtralab-About-externalLinks">
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                {trans.__('xtralab on GitHub')}
              </a>
            </span>
            <span className="jp-xtralab-About-copyright">
              {trans.__('© %1 Jeremy Tuloup', 2026)}
            </span>
          </div>
        );

        return showDialog({
          title,
          body,
          buttons: [
            Dialog.cancelButton({
              label: trans.__('Close')
            })
          ]
        });
      }
    });

    if (palette) {
      palette.addItem({
        command: CommandIDs.about,
        category: trans.__('Help')
      });
    }
  }
};

export default plugin;
