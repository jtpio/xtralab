import type { Terminal } from '@jupyterlab/services';
import type { ITerminalTracker } from '@jupyterlab/terminal';
import type { TranslationBundle } from '@jupyterlab/translation';
import { ISignal, Signal } from '@lumino/signaling';

import { fetchRunningAgents } from './detection';
import type { SessionRegistry, TerminalWidget } from './model';
import type { IAgentTerminalSession, IAgentTerminals } from './tokens';

/**
 * Pause between pasting the prompt and pressing Enter, so the two reach the
 * agent as separate PTY reads — the same shape as a human pasting and then
 * submitting. Sent back to back, the server can coalesce both websocket
 * messages into one read and the TUI would have to split the paste from the
 * trailing Enter inside a single chunk.
 */
const PASTE_SUBMIT_DELAY_MS = 150;

/**
 * Bracketed-paste markers (`CSI 200~` / `CSI 201~`). The prompt is wrapped
 * in these so the agent's TUI treats it as one pasted block — newlines
 * insert into its input box instead of submitting the message at each line
 * break. Every send target is a terminal where detection just confirmed a
 * running coding agent, and the agent TUIs keep bracketed-paste mode on.
 */
const PASTE_OPEN = '\x1b[200~';
const PASTE_CLOSE = '\x1b[201~';

/**
 * How long to wait for the session's websocket to reach `connected` before
 * failing the send, so a server hiccup surfaces as an error notification
 * rather than a silent hang.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Resolve once `session` reports `connected`; reject with `timeoutMessage`
 * after {@link CONNECT_TIMEOUT_MS}. Matches how the launcher waits before
 * typing into a fresh terminal — writes sent while the websocket is still
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
 * terminals panel's {@link SessionRegistry} narrowed to sessions with a
 * detection-confirmed coding agent, plus the "send a prompt into one"
 * action. Lives in the `xtralab:terminals` plugin so the ask-agent popup
 * (and any future caller) can target running agents without duplicating the
 * detection plumbing.
 */
export class AgentTerminals implements IAgentTerminals {
  constructor(options: AgentTerminals.IOptions) {
    this._registry = options.registry;
    this._tracker = options.tracker;
    this._terminals = options.terminals;
    this._detectCommands = options.detectCommands;
    this._isAgentCommand = options.isAgentCommand;
    this._trans = options.trans;
    this._registry.stateChanged.connect(() => this._changed.emit(), this);
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
    // Re-validate against the server rather than trusting the caller's
    // (possibly seconds-old) snapshot: the prompt is prose, and prose pasted
    // into the shell prompt left behind by an exited agent would be
    // *executed* on the Enter below.
    await this._terminals.refreshRunning();
    const alive = Array.from(this._terminals.running()).some(
      model => model.name === name
    );
    if (!alive) {
      throw new Error(this._trans.__('The terminal is no longer running.'));
    }
    const detected = await fetchRunningAgents(this._detectCommands());
    const command = detected?.[name];
    if (typeof command !== 'string' || !this._isAgentCommand(command)) {
      throw new Error(
        this._trans.__('No agent is running in that terminal anymore.')
      );
    }

    // Deliver in the background: write straight to the session over its
    // websocket instead of revealing its tab, so focus stays wherever the
    // user is asking from. An open tab's live connection is reused; a
    // closed tab gets a short-lived client connection to the running server
    // session, without creating any widget.
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
      // Wrapped and newline-normalised exactly like xterm's own paste
      // handling. Writing the markers directly (rather than through an open
      // tab's `Terminal.paste`) also sidesteps the one case paste() gets
      // wrong: a freshly reconnected xterm whose replayed scrollback no
      // longer holds the agent's original mode-setting escape, which makes
      // paste() skip the wrapping the application still expects.
      session.send({
        type: 'stdin',
        content: [PASTE_OPEN + prompt.replace(/\r?\n/g, '\r') + PASTE_CLOSE]
      });
      await new Promise(resolve =>
        window.setTimeout(resolve, PASTE_SUBMIT_DELAY_MS)
      );
      if (session.isDisposed) {
        // The tab closed during the pause; the pasted text already reached
        // the agent's input box but Enter can no longer be delivered here.
        throw new Error(
          this._trans.__('The terminal closed before the prompt was submitted.')
        );
      }
      session.send({ type: 'stdin', content: ['\r'] });
    } finally {
      // Close a connection we opened just for this send. Disposing the
      // client connection leaves the server session (and its agent) running.
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
  /** Construction options for {@link AgentTerminals}. */
  export interface IOptions {
    /** The panel's session registry — the source of the session snapshot. */
    registry: SessionRegistry;

    /** Tracker of open terminal widgets, to reuse an open tab's connection. */
    tracker: ITerminalTracker;

    /** The terminal session manager, for validation and ad-hoc connections. */
    terminals: Terminal.IManager;

    /** Names to detect — same list the registry polls with. */
    detectCommands: () => string[];

    /** Whether a detected command belongs to a coding agent (not an editor). */
    isAgentCommand: (command: string) => boolean;

    /** Translation bundle for the error messages thrown to callers. */
    trans: TranslationBundle;
  }
}
