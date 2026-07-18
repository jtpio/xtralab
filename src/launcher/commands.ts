import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { MainAreaWidget } from '@jupyterlab/apputils';
import type { ITerminal } from '@jupyterlab/terminal';
import type { CommandRegistry } from '@lumino/commands';
import { DisposableSet, type IDisposable } from '@lumino/disposable';

import type { IAgentSessions } from '../agentSessions';
import type { IAgent } from './agents';
import { buildAgentInvocation } from './invocation';
import { agentCommandId } from './tokens';

/**
 * The command id for opening the launcher.
 */
export const CREATE_LAUNCHER_COMMAND = 'launcher:create';

/**
 * Register a JupyterLab command per agent. Each command opens a new
 * terminal via `terminal:create-new` and feeds the agent's shell command
 * into the fresh session as if the user had typed it.
 *
 * Returns a single disposable that tears down every registered command —
 * the launcher disposes the previous set before re-registering on settings
 * changes so the command palette stays in sync with the configured agents.
 *
 * When an `agentSessions` registry is supplied, each launch tags its terminal
 * session with the agent's command, so the terminals panel can badge the row
 * with the agent's logo immediately (before server-side detection confirms
 * it).
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
          // Optimistically tag the session with this agent so the terminals
          // panel can show its logo right away; server-side detection takes
          // over as the source of truth on its next poll.
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
 * label the tab. Shared by the per-agent launch commands and the launcher's
 * editor tile so the fiddly "wait for the websocket, then write stdin"
 * sequence lives in one place.
 *
 * `onSession`, when given, is called once with the new session's name right
 * after the terminal is revealed. Callers use it to optimistically tag the
 * session so the terminals panel can badge it with the agent's (or editor's)
 * logo before server-side detection confirms the running process.
 *
 * Resolves with the host `MainAreaWidget` so the caller can place it — the
 * launcher swaps it into its own tab.
 */
export async function launchInTerminal(
  commands: CommandRegistry,
  options: {
    cwd?: string;
    /**
     * The literal command line typed into the fresh terminal.
     */
    invocation: string;
    /**
     * Tab/title label applied once the command is sent.
     */
    label: string;
    onSession?: (sessionName: string) => void;
  }
): Promise<MainAreaWidget<ITerminal.ITerminal>> {
  const { cwd, invocation, label, onSession } = options;
  const main = (await commands.execute('terminal:create-new', {
    cwd
  })) as MainAreaWidget<ITerminal.ITerminal>;
  // `MainAreaWidget.revealed` chains off the `reveal` promise the terminal
  // extension passes in (the xterm.js widget's own `ready` promise), so
  // awaiting it guarantees the Terminal widget has finished its constructor
  // and connected its session listeners.
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
    // Give the tab and the status-bar list a meaningful default label. The
    // XTerm widget's `_initialConnection` listener overwrites the title with
    // `Terminal {N}` when the WebSocket first reports `connected`; we connect
    // *after* that listener (and call `applyLabel` after `sendCommand`), so by
    // the time we run the upstream listener has already had its turn. Programs
    // that publish a real xterm title escape sequence still win —
    // `XTerm.onTitleChange` resets the label whenever it fires.
    applyLabel();
  };

  // Match how the Terminal widget itself sends its `initialCommand`: either
  // fire immediately if the session is already connected, or wait for the next
  // `connectionStatusChanged` that flips it to `connected`. Without this the
  // stdin write races the websocket handshake and the command silently
  // disappears.
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
