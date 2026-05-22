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
import { EDITOR_CANDIDATES, resolveEditor, type IEditor } from './editors';
import { AgentRegistry } from './registry';
import { IAgentRegistry } from './tokens';

const PLUGIN_ID = 'xtralab:launcher';

/**
 * The xtralab launcher plugin. Replaces the stock JupyterLab launcher
 * (which is disabled via `package.json`'s `jupyterlab.disabledExtensions`)
 * with an agent-focused dashboard: an optional initial prompt, a row of
 * agent buttons (Claude, Codex, Antigravity, …), and a collapsible list of
 * changed files (clickable into the diff viewer) below them. Clicking an
 * agent opens a fresh terminal and pipes the agent's command into it; if
 * the prompt textarea is non-empty, the prompt is shell-quoted and
 * spliced into the launch line per the agent's `promptArgs` recipe.
 *
 * The agent list is the merge of xtralab's defaults with the user's
 * `xtralab:launcher` settings, then filtered by a server-side `which`
 * check so users only see agents that are actually installed. Agents with
 * `requireAvailable: false` (e.g. shell aliases) skip the filter.
 *
 * The plugin deliberately does NOT provide the `ILauncher` token: other
 * extensions register notebook/console/terminal cards on it as a side
 * effect, which would defeat the point of the agent-only launcher. If an
 * extension needs to surface itself, we'll add it here explicitly.
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
    IAgentSessions
  ],
  activate: async (
    app: JupyterFrontEnd,
    labShell: ILabShell | null,
    palette: ICommandPalette | null,
    settingRegistry: ISettingRegistry | null,
    translator: ITranslator | null,
    agentSessions: IAgentSessions | null
  ): Promise<IAgentRegistry> => {
    const { commands, shell } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // The shared agent registry this plugin provides on `IAgentRegistry`.
    // It holds the active agent list (updated whenever settings change), so
    // every freshly-created launcher widget — and any other plugin that
    // consumes the token, e.g. the terminals panel — renders the latest list.
    const registry = new AgentRegistry();

    // Track command registrations so a settings change can wipe them
    // before re-registering — without this the command palette would
    // accumulate stale entries when the agent list shrinks.
    let registered: IDisposable | null = null;

    // The editor tile (Neovim, else Vim) to hand the next launcher widget,
    // resolved alongside the agents from the same availability probe. Like
    // `registry.agents`, freshly-created launchers read the current value;
    // already-open launchers keep what they were built with.
    let currentEditor: IEditor | null = null;

    const applyAgents = async (overrides: IAgentSettings[]): Promise<void> => {
      const agents = mergeAgents(overrides);

      // One availability probe covers both the agent commands and the editor
      // candidates, so a settings change costs a single round-trip. Agents
      // with `requireAvailable: false` opt out (their command may be a shell
      // alias that `which` can't see) and are kept regardless.
      const probe = Array.from(
        new Set([
          ...agents
            .filter(agent => agent.requireAvailable)
            .map(agent => agent.command),
          ...EDITOR_CANDIDATES.map(editor => editor.command)
        ])
      );
      const available = await fetchAvailableCommands(probe);

      const filtered = filterAgents(agents, available);
      currentEditor = resolveEditor(available);

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
        const onAgentLaunch = (item: Widget): void => {
          // When an agent command returns a Widget that ends up in the main
          // area, slot it where this launcher used to sit so opening an
          // agent feels like the launcher transformed into the terminal.
          // Disposing the inner ReactWidget cascades to the MainAreaWidget
          // host via its `content.disposed` connection.
          if (find(shell.widgets('main'), w => w === item)) {
            shell.add(item, 'main', { ref: id });
            launcher.dispose();
          }
        };
        const launcher = new LauncherDashboard({
          commands,
          agents: registry.agents,
          editor: currentEditor,
          agentSessions,
          onAgentLaunch,
          // Empty repoPath/cwd matches the JupyterLab convention used by
          // the git panel and the stock launcher: let the server resolve
          // the working tree from its root directory.
          repoPath: '',
          cwd: ''
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

    return registry;
  }
};

/**
 * Drop agents whose command isn't on `$PATH`, except entries that opt out via
 * `requireAvailable: false` (e.g. shell aliases the user wants surfaced
 * regardless). `available` is the resolved set from
 * {@link fetchAvailableCommands}.
 *
 * When `available` is `null` (the endpoint couldn't be reached) we fail open
 * and return the input unchanged — better to show an unreachable agent than
 * to hide the entire launcher because the server extension didn't load. The
 * editor tile resolves from the same set but fails closed; see
 * {@link resolveEditor}.
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
   * Returns the next unique launcher widget id.
   */
  export function nextId(): string {
    return `launcher-${counter++}`;
  }
}

export default plugin;
