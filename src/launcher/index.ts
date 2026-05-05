import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, MainAreaWidget } from '@jupyterlab/apputils';
import { Launcher, LauncherModel } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { launcherIcon } from '@jupyterlab/ui-components';
import { find } from '@lumino/algorithm';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { DisposableSet, type IDisposable } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';

import { mergeAgents, type IAgent, type IAgentSettings } from './agents';
import { fetchAvailableCommands } from './availability';
import {
  CREATE_LAUNCHER_COMMAND,
  agentCommandId,
  registerAgentCommands
} from './commands';

const PLUGIN_ID = 'xtralab:launcher';

const AGENT_CATEGORY = 'Agents';

/**
 * The xtralab launcher plugin. Replaces the stock JupyterLab launcher
 * (which is disabled via `package.json`'s `jupyterlab.disabledExtensions`)
 * with a pared-down launcher whose only cards are CLI agents (Claude,
 * Codex, Gemini, …). Clicking a card opens a fresh terminal in the main
 * area and pipes the agent's shell command into it.
 *
 * The card list is the merge of xtralab's defaults with the user's
 * `xtralab:launcher` settings, then filtered by a server-side `which`
 * check so users only see agents that are actually installed. Agents with
 * `requireAvailable: false` (e.g. shell aliases) skip the filter.
 *
 * The plugin deliberately does NOT provide the `ILauncher` token: other
 * extensions register notebook/console/terminal cards on it as a side
 * effect, which would defeat the point of the agent-only launcher. If an
 * extension needs to surface itself, we'll add it here explicitly.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'An agent-focused launcher that replaces the default JupyterLab launcher.',
  autoStart: true,
  optional: [ILabShell, ICommandPalette, ISettingRegistry, ITranslator],
  activate: async (
    app: JupyterFrontEnd,
    labShell: ILabShell | null,
    palette: ICommandPalette | null,
    settingRegistry: ISettingRegistry | null,
    translator: ITranslator | null
  ): Promise<void> => {
    const { commands, shell } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // Single shared launcher model so re-opening the launcher tab is cheap
    // and items added later show up in every existing launcher view.
    const model = new LauncherModel();

    // Track everything we register from `applyAgents` so a settings change
    // can wipe the slate clean before reapplying — without this the
    // command palette and launcher model would accumulate stale entries.
    let registered: IDisposable | null = null;

    const applyAgents = async (overrides: IAgentSettings[]): Promise<void> => {
      const agents = mergeAgents(overrides);
      const filtered = await filterByAvailability(agents);

      registered?.dispose();

      const disposables = new DisposableSet();
      disposables.add(registerAgentCommands(app, filtered));
      for (const agent of filtered) {
        disposables.add(
          model.add({
            command: agentCommandId(agent.id),
            category: AGENT_CATEGORY,
            rank: agent.rank,
            categoryRank: 0
          })
        );
      }
      registered = disposables;
    };

    const readOverrides = (
      settings: ISettingRegistry.ISettings
    ): IAgentSettings[] => {
      const raw = settings.composite.agents;
      return Array.isArray(raw) ? (raw as IAgentSettings[]) : [];
    };

    if (settingRegistry) {
      try {
        const settings = await settingRegistry.load(PLUGIN_ID);
        await applyAgents(readOverrides(settings));
        settings.changed.connect(async () => {
          try {
            await applyAgents(readOverrides(settings));
          } catch (reason) {
            console.error(
              'xtralab: failed to reapply launcher settings',
              reason
            );
          }
        });
      } catch (reason) {
        console.error('xtralab: failed to load launcher settings', reason);
        // Settings load failed — fall back to defaults so the launcher
        // still has cards instead of going silent.
        await applyAgents([]);
      }
    } else {
      await applyAgents([]);
    }

    commands.addCommand(CREATE_LAUNCHER_COMMAND, {
      label: trans.__('New Launcher'),
      execute: (args: ReadonlyPartialJSONObject) => {
        const id = Private.nextId();
        const callback = (item: Widget): void => {
          // When an agent command returns a Widget that ends up in the main
          // area, slot it where this launcher used to sit so opening an
          // agent feels like the launcher transformed into the terminal.
          if (find(shell.widgets('main'), w => w === item)) {
            shell.add(item, 'main', { ref: id });
            launcher.dispose();
          }
        };
        const launcher = new Launcher({
          model,
          cwd: '',
          callback,
          commands,
          translator: translator ?? nullTranslator
        });
        launcher.title.icon = launcherIcon;
        launcher.title.label = trans.__('Launcher');

        const main = new MainAreaWidget({ content: launcher });
        // Hide the close button when the launcher is the only thing in the
        // main area: closing it would leave the user staring at an empty
        // shell with no way back.
        main.title.closable = !!Array.from(shell.widgets('main')).length;
        main.id = id;

        shell.add(main, 'main', {
          activate: args['activate'] as boolean,
          ref: args['ref'] as string
        });

        if (labShell) {
          labShell.layoutModified.connect(() => {
            main.title.closable =
              Array.from(labShell.widgets('main')).length > 1;
          }, main);
        }

        return main;
      }
    });

    if (palette) {
      palette.addItem({
        command: CREATE_LAUNCHER_COMMAND,
        category: trans.__('Launcher')
      });
    }

    if (labShell) {
      void app.restored.then(() => {
        const maybeCreate = (): void => {
          if (labShell.isEmpty('main')) {
            void commands.execute(CREATE_LAUNCHER_COMMAND);
          }
        };
        labShell.layoutModified.connect(() => {
          maybeCreate();
        });
        // Layout has settled by the time `app.restored` resolves; if it's
        // empty (fresh start, no restored widgets) the connect above won't
        // fire on its own — kick it off here.
        maybeCreate();
      });

      labShell.addButtonEnabled = true;
      labShell.addRequested.connect((sender, arg) => {
        const ref =
          arg.currentTitle?.owner.id ||
          arg.titles[arg.titles.length - 1].owner.id;
        return commands.execute(CREATE_LAUNCHER_COMMAND, { ref });
      });
    }
  }
};

/**
 * Drop agents whose command isn't on `$PATH`, except for entries that
 * explicitly opt out of the check via `requireAvailable: false` (typical
 * use case: shell aliases the user wants surfaced regardless).
 *
 * If the availability endpoint can't be reached we fail open and return
 * the input unchanged — better to show an unreachable agent than to hide
 * the entire launcher because the server extension didn't load.
 */
async function filterByAvailability(agents: IAgent[]): Promise<IAgent[]> {
  const commands = agents
    .filter(agent => agent.requireAvailable)
    .map(agent => agent.command);
  if (commands.length === 0) {
    return agents;
  }
  const available = await fetchAvailableCommands(commands);
  if (!available) {
    return agents;
  }
  return agents.filter(
    agent => !agent.requireAvailable || available.has(agent.command)
  );
}

namespace Private {
  let counter = 0;

  /**
   * Returns the next unique launcher widget id.
   */
  export function nextId(): string {
    return `launcher-${counter++}`;
  }
}

export default plugin;
