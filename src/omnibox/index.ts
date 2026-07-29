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
 * The omnibox: a single launcher overlay that fuzzy-searches workspace files
 * (via jupyterlab-quickopen's gitignore-aware endpoint) and JupyterLab
 * commands (the command palette's entries plus registry commands the palette
 * doesn't list), and routes a typed prompt to one of the configured agents
 * (running it in a fresh terminal through the launcher's
 * `xtralab:start-agent:<id>` commands). It is opened by the top-bar command
 * bar.
 *
 * Commands run and files opened through the overlay are remembered (persisted
 * in the state database) and offered again at the top while the query is
 * empty; the `maxNumberRecents` setting caps how many of each are kept.
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

    // The palette's items carry per-item args (e.g. one "Use Theme: …" per
    // theme) that a raw command-registry scan can't see, but `ICommandPalette`
    // exposes no item list and the widget itself is unreachable through the
    // shell (`LabShell.add` defers it until layout restore, after which the
    // modal setting re-parents it out of the left area). The wrapper's
    // `_palette` field is private in TypeScript only, so read it guarded.
    const paletteItems = (): ReadonlyArray<CommandPalette.IItem> => {
      const widget = (palette as unknown as { _palette?: unknown } | null)
        ?._palette;
      return widget instanceof CommandPalette ? [...widget.items] : [];
    };

    const recents = new OmniboxRecents({ state });

    // Restore the persisted recents only after the configured cap is known:
    // `restore` trims to `maxItems`, so restoring at the constructor default
    // would permanently drop entries beyond it whenever the user configured a
    // larger cap and the state fetch won the race against the settings load.
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
      // current; the file list is cached separately (see files.ts).
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
