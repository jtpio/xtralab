import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { MainAreaWidget } from '@jupyterlab/apputils';
import type { ITerminal } from '@jupyterlab/terminal';
import { DisposableSet, type IDisposable } from '@lumino/disposable';

import type { IAgent } from './agents';
import { buildAgentInvocation } from './invocation';

/**
 * The command id for opening the launcher.
 */
export const CREATE_LAUNCHER_COMMAND = 'launcher:create';

/**
 * Build a JupyterLab command id for a given agent. Centralised so the
 * plugin and the launcher both use the same names.
 */
export function agentCommandId(agentId: string): string {
  return `xtralab:start-agent:${agentId}`;
}

/**
 * Register a JupyterLab command per agent. Each command opens a new
 * terminal via `terminal:create-new` and feeds the agent's shell command
 * into the fresh session as if the user had typed it.
 *
 * Returns a single disposable that tears down every registered command —
 * the launcher disposes the previous set before re-registering on settings
 * changes so the command palette stays in sync with the configured agents.
 */
export function registerAgentCommands(
  app: JupyterFrontEnd,
  agents: IAgent[]
): IDisposable {
  const disposables = new DisposableSet();
  for (const agent of agents) {
    const disposable = app.commands.addCommand(agentCommandId(agent.id), {
      label: agent.label,
      caption: agent.caption,
      icon: agent.icon,
      execute: async args => {
        const cwd = args['cwd'] as string | undefined;
        const promptArg = args['prompt'];
        const prompt = typeof promptArg === 'string' ? promptArg : '';
        const invocation = buildAgentInvocation(agent, prompt);
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
            content: [invocation + '\r']
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
    disposables.add(disposable);
  }
  return disposables;
}
