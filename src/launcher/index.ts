import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, MainAreaWidget } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { launcherIcon } from '@jupyterlab/ui-components';
import { find } from '@lumino/algorithm';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';

import { IAgentSessions } from '../agentSessions';
import { mergeAgents, type IAgent, type IAgentSettings } from './agents';
import { fetchAvailableCommands } from './availability';
import { CREATE_LAUNCHER_COMMAND, registerAgentCommands } from './commands';
import { LauncherDashboard } from './dashboard';
import { editorRegistryPlugin, IEditorRegistry } from './editorRegistry';
import { AgentRegistry } from './registry';
import { registerLauncherSchemaDefaults } from './schemaDefaults';
import { IAgentRegistry } from './tokens';

const PLUGIN_ID = 'xtralab:launcher';

/**
 * The xtralab launcher plugin: replaces the stock JupyterLab launcher
 * (disabled via `jupyterlab.disabledExtensions`) with an agent-focused
 * dashboard. It deliberately does NOT provide `ILauncher` — other extensions
 * would register their cards on it and defeat the agent-only design.
 */
const plugin: JupyterFrontEndPlugin<IAgentRegistry> = {
  id: PLUGIN_ID,
  description:
    'An agent-focused launcher that replaces the default JupyterLab launcher.',
  autoStart: true,
  provides: IAgentRegistry,
  optional: [
    ILabShell,
    ICommandPalette,
    ISettingRegistry,
    ITranslator,
    IAgentSessions,
    IEditorRegistry
  ],
  activate: async (
    app: JupyterFrontEnd,
    labShell: ILabShell | null,
    palette: ICommandPalette | null,
    settingRegistry: ISettingRegistry | null,
    translator: ITranslator | null,
    agentSessions: IAgentSessions | null,
    editorRegistry: IEditorRegistry | null
  ): Promise<IAgentRegistry> => {
    const { commands, shell } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    const registry = new AgentRegistry();

    let registered: IDisposable | null = null;

    const applyAgents = async (overrides: IAgentSettings[]): Promise<void> => {
      const agents = mergeAgents(overrides);

      const probe = Array.from(
        new Set(
          agents
            .filter(agent => agent.requireAvailable)
            .map(agent => agent.command)
        )
      );
      const available = await fetchAvailableCommands(probe);

      const filtered = filterAgents(agents, available);

      registered?.dispose();
      registered = registerAgentCommands(app, filtered, agentSessions);
      registry.setAgents(filtered);
    };

    const readOverrides = (
      settings: ISettingRegistry.ISettings
    ): IAgentSettings[] => {
      const raw = settings.composite.agents;
      return Array.isArray(raw) ? (raw as IAgentSettings[]) : [];
    };

    if (settingRegistry) {
      // Must precede the first `load`: the schema defers loading until a
      // transform is registered.
      registerLauncherSchemaDefaults(settingRegistry);
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
        await applyAgents([]);
      }
    } else {
      await applyAgents([]);
    }

    commands.addCommand(CREATE_LAUNCHER_COMMAND, {
      label: trans.__('New Launcher'),
      execute: (args: ReadonlyPartialJSONObject) => {
        const id = Private.nextId();
        const onAgentLaunch = (item: Widget): void => {
          // Slot the widget where this launcher sits; disposing the inner
          // ReactWidget cascades to its MainAreaWidget host via `content.disposed`.
          if (find(shell.widgets('main'), w => w === item)) {
            shell.add(item, 'main', { ref: id });
            launcher.dispose();
          }
        };
        const launcher = new LauncherDashboard({
          commands,
          agents: registry.agents,
          editor: editorRegistry?.current ?? null,
          agentSessions,
          onAgentLaunch,
          repoPath: '',
          cwd: '',
          trans
        });
        launcher.title.icon = launcherIcon;
        launcher.title.label = trans.__('Launcher');

        const main = new MainAreaWidget({ content: launcher });
        // Closing the only main-area widget would leave an empty shell.
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
        // If the restored layout is already empty the connect never fires.
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

    return registry;
  }
};

/**
 * Drop agents whose command isn't on `$PATH`, keeping `requireAvailable:
 * false` entries. When `available` is `null` (probe failed), fail open and
 * return the input unchanged.
 */
function filterAgents(
  agents: IAgent[],
  available: Set<string> | null
): IAgent[] {
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
   * Generate a unique id for a launcher widget.
   */
  export function nextId(): string {
    return `launcher-${counter++}`;
  }
}

const plugins: JupyterFrontEndPlugin<unknown>[] = [
  plugin,
  editorRegistryPlugin
];

export default plugins;
