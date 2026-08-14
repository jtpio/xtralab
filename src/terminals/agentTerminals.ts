import type { Terminal } from '@jupyterlab/services';
import type { ITerminalTracker } from '@jupyterlab/terminal';
import type { TranslationBundle } from '@jupyterlab/translation';
import { ISignal, Signal } from '@lumino/signaling';

import { fetchRunningAgents } from './detection';
import type { SessionRegistry, TerminalWidget } from './model';
import type { IAgentTerminalSession, IAgentTerminals } from './tokens';

/**
 * Pause between pasting the prompt and pressing Enter so the server cannot
 * coalesce both websocket messages into one PTY read.
 */
const PASTE_SUBMIT_DELAY_MS = 150;

/**
 * Bracketed-paste markers (`CSI 200~` / `CSI 201~`): a wrapped prompt arrives
 * as one pasted block, so newlines insert instead of submitting at each break.
 */
const PASTE_OPEN = '\x1b[200~';
const PASTE_CLOSE = '\x1b[201~';

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Resolve once `session` reports `connected`; reject with `timeoutMessage`
 * after {@link CONNECT_TIMEOUT_MS} — writes sent while the websocket is still
 * connecting disappear silently.
 */
function waitUntilConnected(
  session: Terminal.ITerminalConnection,
  timeoutMessage: string
): Promise<void> {
  if (session.connectionStatus === 'connected') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timer);
      session.connectionStatusChanged.disconnect(onStatus);
    };
    const onStatus = (): void => {
      if (session.connectionStatus === 'connected') {
        cleanup();
        resolve();
      }
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, CONNECT_TIMEOUT_MS);
    session.connectionStatusChanged.connect(onStatus);
  });
}

/**
 * The {@link IAgentTerminals} implementation: a read-only view over the
 * panel's {@link SessionRegistry} narrowed to sessions with a
 * detection-confirmed coding agent, plus the "send a prompt into one" action.
 */
export class AgentTerminals implements IAgentTerminals {
  constructor(options: AgentTerminals.IOptions) {
    this._registry = options.registry;
    this._tracker = options.tracker;
    this._terminals = options.terminals;
    this._detectCommands = options.detectCommands;
    this._isAgentCommand = options.isAgentCommand;
    this._trans = options.trans;
    this._registry.stateChanged.connect(this._onRegistryStateChanged, this);
  }

  sessions(): IAgentTerminalSession[] {
    const result: IAgentTerminalSession[] = [];
    for (const name of this._registry.sessionNames()) {
      const command = this._registry.detectedCommandFor(name);
      if (command === null || !this._isAgentCommand(command)) {
        continue;
      }
      result.push({
        name,
        command,
        label: this._registry.labelFor(name),
        activity: this._registry.activityFor(name)
      });
    }
    return result;
  }

  get changed(): ISignal<IAgentTerminals, void> {
    return this._changed;
  }

  async sendPrompt(name: string, prompt: string): Promise<void> {
    // Re-validate against the server: prose pasted into the shell prompt an
    // exited agent left behind would be *executed* on the Enter below.
    await this._terminals.refreshRunning();
    const alive = Array.from(this._terminals.running()).some(
      model => model.name === name
    );
    if (!alive) {
      throw new Error(this._trans.__('The terminal is no longer running.'));
    }
    const detected = await fetchRunningAgents(this._detectCommands());
    if (detected === null) {
      // Detection unavailable (older server, transient failure) is not proof
      // the agent is gone; refuse the write and invite a retry.
      throw new Error(
        this._trans.__('Could not verify the terminal — try sending again.')
      );
    }
    const command = detected[name];
    if (typeof command !== 'string' || !this._isAgentCommand(command)) {
      throw new Error(
        this._trans.__('No agent is running in that terminal anymore.')
      );
    }

    const widget = this._findWidget(name);
    const session =
      widget !== null
        ? widget.content.session
        : this._terminals.connectTo({ model: { name } });
    try {
      await waitUntilConnected(
        session,
        this._trans.__('Timed out connecting to the terminal.')
      );
      // Writing the markers directly (not `Terminal.paste`) sidesteps paste()
      // skipping them on a reconnected xterm that lost the mode-setting escape.
      session.send({
        type: 'stdin',
        content: [PASTE_OPEN + prompt.replace(/\r?\n/g, '\r') + PASTE_CLOSE]
      });
      await new Promise(resolve =>
        window.setTimeout(resolve, PASTE_SUBMIT_DELAY_MS)
      );
      if (session.isDisposed) {
        throw new Error(
          this._trans.__('The terminal closed before the prompt was submitted.')
        );
      }
      session.send({ type: 'stdin', content: ['\r'] });
    } finally {
      // Disposing an ad-hoc client connection leaves the server session
      // (and its agent) running.
      if (widget === null && !session.isDisposed) {
        session.dispose();
      }
    }
  }

  private _findWidget(name: string): TerminalWidget | null {
    return (
      this._tracker.find(widget => widget.content.session.name === name) ?? null
    );
  }

  private _onRegistryStateChanged(): void {
    this._changed.emit();
  }

  private _registry: SessionRegistry;
  private _tracker: ITerminalTracker;
  private _terminals: Terminal.IManager;
  private _detectCommands: () => string[];
  private _isAgentCommand: (command: string) => boolean;
  private _trans: TranslationBundle;
  private _changed = new Signal<IAgentTerminals, void>(this);
}

/**
 * A namespace for `AgentTerminals` statics.
 */
export namespace AgentTerminals {
  /**
   * Construction options for {@link AgentTerminals}.
   */
  export interface IOptions {
    registry: SessionRegistry;
    tracker: ITerminalTracker;
    terminals: Terminal.IManager;
    detectCommands: () => string[];
    isAgentCommand: (command: string) => boolean;
    trans: TranslationBundle;
  }
}
