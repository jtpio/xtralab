import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { MainAreaWidget } from '@jupyterlab/apputils';
import type { ITerminal } from '@jupyterlab/terminal';
import type { CommandRegistry } from '@lumino/commands';
import { DisposableSet, type IDisposable } from '@lumino/disposable';

import type { IAgentSessions } from '../agentSessions';
import type { IAgent } from './agents';
import { buildAgentInvocation } from './invocation';
import { agentCommandId } from './tokens';

export const CREATE_LAUNCHER_COMMAND = 'launcher:create';

/**
 * Register a JupyterLab command per agent that opens a new terminal and types
 * the agent's shell command into it. Returns one disposable tearing down every
 * command, so a settings change can re-register without stale palette entries.
 * `agentSessions`, when given, launch-tags each session for the terminals panel.
 */
export function registerAgentCommands(
  app: JupyterFrontEnd,
  agents: IAgent[],
  agentSessions: IAgentSessions | null = null
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
        return launchInTerminal(app.commands, {
          cwd,
          invocation,
          label: agent.label,
          // Optimistic tag; server-side detection takes over on its next poll.
          onSession: name => agentSessions?.set(name, agent.command)
        });
      }
    });
    disposables.add(disposable);
  }
  return disposables;
}

/**
 * Open a fresh terminal, type `invocation` into it as if the user had, and
 * label the tab. `onSession` receives the new session's name so callers can
 * launch-tag it for the terminals panel. Resolves with the host
 * `MainAreaWidget` so the caller can place it.
 */
export async function launchInTerminal(
  commands: CommandRegistry,
  options: {
    cwd?: string;
    invocation: string;
    label: string;
    onSession?: (sessionName: string) => void;
  }
): Promise<MainAreaWidget<ITerminal.ITerminal>> {
  const { cwd, invocation, label, onSession } = options;
  const main = (await commands.execute('terminal:create-new', {
    cwd
  })) as MainAreaWidget<ITerminal.ITerminal>;
  // `revealed` chains off the terminal's `ready` promise, so awaiting it
  // guarantees the widget finished construction and connected its listeners.
  await main.revealed;

  const session = main.content.session;
  onSession?.(session.name);

  const applyLabel = (): void => {
    if (main.isDisposed || main.content.isDisposed) {
      return;
    }
    main.content.title.label = label;
  };

  const sendCommand = (): void => {
    session.send({
      type: 'stdin',
      content: [invocation + '\r']
    });
    // XTerm's `_initialConnection` resets the title on first connect; we run
    // after it, so this label survives. A title escape still wins (`onTitleChange`).
    applyLabel();
  };

  // Without waiting for `connected` the stdin write races the websocket
  // handshake and the command silently disappears.
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
