import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { MainAreaWidget } from '@jupyterlab/apputils';
import type { ITerminal } from '@jupyterlab/terminal';
import type { CommandRegistry } from '@lumino/commands';
import { DisposableSet, type IDisposable } from '@lumino/disposable';

import type { IAgentSessions } from '../agentSessions';
import { hasServerExtension } from '../server';
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
        if (agent.start) {
          return agent.start({ prompt, cwd });
        }
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
  // handshake and the command silently disappears. The JupyterLite shell
  // also queries the terminal colors when it starts, and reads the command
  // as the answer if it comes too early: there, wait for its output to settle.
  const waitForPrompt = !hasServerExtension();
  let sent = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const sendOnce = (): void => {
    if (!sent) {
      sent = true;
      clearTimeout(settle);
      session.messageReceived.disconnect(onMessage);
      sendCommand();
    }
  };
  const onMessage = (sender: unknown, message: { type: string }): void => {
    if (message.type === 'stdout') {
      clearTimeout(settle);
      settle = setTimeout(sendOnce, SETTLE_MS);
    }
  };
  const onConnected = (): void => {
    if (session.connectionStatus !== 'connected') {
      return;
    }
    session.connectionStatusChanged.disconnect(onConnected);
    if (waitForPrompt) {
      setTimeout(sendOnce, PROMPT_TIMEOUT_MS);
    } else {
      sendOnce();
    }
  };
  if (waitForPrompt) {
    session.messageReceived.connect(onMessage);
  }
  session.connectionStatusChanged.connect(onConnected);
  onConnected();

  return main;
}

/**
 * How long the output of a JupyterLite shell must stay quiet before the
 * command is sent, and the longest wait for it.
 */
const SETTLE_MS = 300;
const PROMPT_TIMEOUT_MS = 5000;
