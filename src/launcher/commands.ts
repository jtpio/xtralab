import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { MainAreaWidget } from '@jupyterlab/apputils';
import type { ITerminal } from '@jupyterlab/terminal';
import type { LabIcon } from '@jupyterlab/ui-components';

import { claudeIcon, codexIcon, geminiIcon } from './icons';

/**
 * The command id for opening the launcher.
 */
export const CREATE_LAUNCHER_COMMAND = 'launcher:create';

/**
 * Description of a single agent shown as a launcher card. The `command` is
 * the shell command typed into the new terminal; the `commandId` is the
 * JupyterLab command registered to drive that terminal.
 */
export interface IAgent {
  id: string;
  label: string;
  caption: string;
  command: string;
  icon: LabIcon;
  rank: number;
}

/**
 * Build a JupyterLab command id for a given agent. Centralised so the plugin
 * and the launcher both use the same names.
 */
export function agentCommandId(agentId: string): string {
  return `xtralab:start-agent:${agentId}`;
}

/**
 * The agents the launcher exposes. Order in this array also seeds the rank
 * so the cards render in the order declared here.
 */
export const AGENTS: IAgent[] = [
  {
    id: 'claude',
    label: 'Claude',
    caption: 'Start Claude Code in a new terminal.',
    command: 'claude',
    icon: claudeIcon,
    rank: 0
  },
  {
    id: 'codex',
    label: 'Codex',
    caption: 'Start the Codex CLI in a new terminal.',
    command: 'codex',
    icon: codexIcon,
    rank: 1
  },
  {
    id: 'gemini',
    label: 'Gemini',
    caption: 'Start the Gemini CLI in a new terminal.',
    command: 'gemini',
    icon: geminiIcon,
    rank: 2
  }
];

/**
 * Register a JupyterLab command per agent. Each command opens a new terminal
 * via `terminal:create-new` and feeds the agent's shell command into the
 * fresh session as if the user had typed it.
 */
export function registerAgentCommands(app: JupyterFrontEnd): void {
  for (const agent of AGENTS) {
    app.commands.addCommand(agentCommandId(agent.id), {
      label: agent.label,
      caption: agent.caption,
      icon: agent.icon,
      execute: async args => {
        const cwd = args['cwd'] as string | undefined;
        const main = (await app.commands.execute('terminal:create-new', {
          cwd
        })) as MainAreaWidget<ITerminal.ITerminal>;
        // `MainAreaWidget.revealed` chains off the `reveal` promise the
        // terminal extension passes in (the xterm.js widget's own `ready`
        // promise), so awaiting it guarantees the Terminal widget has
        // finished its constructor and connected its session listeners.
        await main.revealed;

        const session = main.content.session;
        const sendCommand = (): void => {
          session.send({
            type: 'stdin',
            content: [agent.command + '\r']
          });
        };

        // Match how the Terminal widget itself sends its `initialCommand`:
        // either fire immediately if the session is already connected, or
        // wait for the next `connectionStatusChanged` that flips it to
        // `connected`. Without this the stdin write races the websocket
        // handshake and the agent command silently disappears.
        if (session.connectionStatus === 'connected') {
          sendCommand();
        } else {
          const onStatus = (): void => {
            if (session.connectionStatus === 'connected') {
              session.connectionStatusChanged.disconnect(onStatus);
              sendCommand();
            }
          };
          session.connectionStatusChanged.connect(onStatus);
        }

        return main;
      }
    });
  }
}
