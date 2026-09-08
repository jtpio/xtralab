import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { CommandPalette, Widget } from '@lumino/widgets';

import { IAgentRegistry } from '../launcher/tokens';

import { OmniboxRecents } from './recents';
import { IOmnibox, OMNIBOX_OPEN_COMMAND } from './tokens';
import { OmniboxWidget } from './widget';

const PLUGIN_ID = 'xtralab:omnibox';

/**
 * The omnibox: a launcher overlay that fuzzy-searches workspace files and
 * commands and routes a typed prompt to a configured agent in a fresh
 * terminal. Recently used commands and files persist in the state database;
 * without the launcher it still searches files and commands.
 */
const plugin: JupyterFrontEndPlugin<IOmnibox> = {
  id: PLUGIN_ID,
  description:
    'A launcher overlay that searches files and commands and prompts agents.',
  autoStart: true,
  provides: IOmnibox,
  optional: [
    IAgentRegistry,
    ICommandPalette,
    ISettingRegistry,
    IStateDB,
    ITranslator
  ],
  activate: (
    app: JupyterFrontEnd,
    agentRegistry: IAgentRegistry | null,
    palette: ICommandPalette | null,
    settingRegistry: ISettingRegistry | null,
    state: IStateDB | null,
    translator: ITranslator | null
  ): IOmnibox => {
    const { commands, docRegistry } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    const placeholder = trans.__('Search files and commands, or ask an agent…');

    // `ICommandPalette` exposes no item list and the palette widget is
    // unreachable through the shell; duck-read the wrapper's TS-only-private `_palette`.
    const paletteItems = (): ReadonlyArray<CommandPalette.IItem> => {
      const widget = (palette as unknown as { _palette?: unknown } | null)
        ?._palette;
      return widget instanceof CommandPalette ? [...widget.items] : [];
    };

    const recents = new OmniboxRecents({ state });

    // Restore only after the configured cap is known: `restore` trims to
    // `maxItems`, so restoring at the default could permanently drop entries.
    if (settingRegistry) {
      void settingRegistry
        .load(PLUGIN_ID)
        .then(settings => {
          const apply = (): void => {
            const value = settings.get('maxNumberRecents').composite;
            if (typeof value === 'number') {
              recents.maxItems = value;
            }
          };
          apply();
          settings.changed.connect(apply);
          void recents.restore();
        })
        .catch(reason => {
          console.error(
            `xtralab omnibox: failed to load settings for ${PLUGIN_ID}`,
            reason
          );
          void recents.restore();
        });
    } else {
      void recents.restore();
    }

    let current: OmniboxWidget | null = null;

    const close = (): void => {
      const widget = current;
      current = null;
      widget?.dispose();
    };

    const open = (query?: string): void => {
      // Reopen fresh each time so the input resets and the agent snapshot is
      // current; the file list stays cached (files.ts).
      close();
      const widget = new OmniboxWidget({
        commands,
        paletteItems: paletteItems(),
        docRegistry,
        agents: agentRegistry ? agentRegistry.agents : [],
        placeholder,
        initialQuery: query ?? '',
        recents,
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
        if (current && !current.isDisposed) {
          close();
          return;
        }
        const query = args['query'];
        open(typeof query === 'string' ? query : undefined);
      }
    });

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
