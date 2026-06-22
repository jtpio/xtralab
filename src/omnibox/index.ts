import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';

import { IAgentRegistry } from '../launcher/tokens';

import { IOmnibox, OMNIBOX_OPEN_COMMAND } from './tokens';
import { OmniboxWidget } from './widget';

const PLUGIN_ID = 'xtralab:omnibox';

/**
 * The omnibox: a single launcher overlay that fuzzy-searches workspace files
 * (via jupyterlab-quickopen's gitignore-aware endpoint) and JupyterLab
 * commands, and routes a typed prompt to one of the configured agents (running
 * it in a fresh terminal through the launcher's `xtralab:start-agent:<id>`
 * commands). It is opened by the top-bar command bar.
 *
 * The agent rows come from the launcher's `IAgentRegistry`; when the launcher
 * is disabled the omnibox still searches files and commands.
 */
const plugin: JupyterFrontEndPlugin<IOmnibox> = {
  id: PLUGIN_ID,
  description:
    'A launcher overlay that searches files and commands and prompts agents.',
  autoStart: true,
  provides: IOmnibox,
  optional: [IAgentRegistry, ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    agentRegistry: IAgentRegistry | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): IOmnibox => {
    const { commands, docRegistry } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    const placeholder = trans.__('Search files and commands, or ask an agent…');

    let current: OmniboxWidget | null = null;

    const close = (): void => {
      const widget = current;
      current = null;
      widget?.dispose();
    };

    const open = (query?: string): void => {
      // Reopen fresh each time so the input resets and the agent snapshot is
      // current; the file list is cached separately (see files.ts).
      close();
      const widget = new OmniboxWidget({
        commands,
        docRegistry,
        agents: agentRegistry ? agentRegistry.agents : [],
        placeholder,
        initialQuery: query ?? '',
        trans,
        onClose: close
      });
      current = widget;
      widget.disposed.connect(() => {
        if (current === widget) {
          current = null;
        }
      });
      Widget.attach(widget, document.body);
    };

    commands.addCommand(OMNIBOX_OPEN_COMMAND, {
      label: trans.__('Search…'),
      caption: trans.__('Search files and commands, or ask an agent'),
      execute: args => {
        // Toggle: a second press (e.g. of the keyboard shortcut) closes it.
        if (current && !current.isDisposed) {
          close();
          return;
        }
        const query = args['query'];
        open(typeof query === 'string' ? query : undefined);
      }
    });

    // Open the omnibox with Cmd/Ctrl+K, the common "command center" chord.
    commands.addKeyBinding({
      command: OMNIBOX_OPEN_COMMAND,
      keys: ['Accel K'],
      selector: 'body'
    });

    if (palette) {
      palette.addItem({
        command: OMNIBOX_OPEN_COMMAND,
        category: trans.__('Other')
      });
    }

    return { open, close };
  }
};

export default plugin;
