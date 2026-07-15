import type { Terminal } from '@jupyterlab/services';
import type { ITerminalTracker } from '@jupyterlab/terminal';
import type { TranslationBundle } from '@jupyterlab/translation';
import type { CommandRegistry } from '@lumino/commands';
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
 * The {@link IAgentTerminals} implementation: a read-only view over the
 * terminals panel's {@link SessionRegistry} narrowed to sessions with a
 * detection-confirmed coding agent, plus the "paste a prompt into one"
 * action. Lives in the `xtralab:terminals` plugin so the ask-agent popup
 * (and any future caller) can target running agents without duplicating the
 * detection plumbing.
 */
export class AgentTerminals implements IAgentTerminals {
  constructor(options: AgentTerminals.IOptions) {
    this._registry = options.registry;
    this._tracker = options.tracker;
    this._commands = options.commands;
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

    // Reveal the target so the user sees the prompt land: activate the open
    // tab, or reopen one — `terminal:create-new` with the name of a running
    // session connects to it instead of spawning a fresh one.
    let main = this._findWidget(name);
    if (main !== null) {
      void this._commands.execute('terminal:open', { name });
    } else {
      main = (await this._commands.execute('terminal:create-new', {
        name
      })) as TerminalWidget;
    }
    // `revealed` resolves once the widget's xterm is ready — `paste` before
    // that is a silent no-op.
    await main.revealed;

    // `paste` goes through xterm's clipboard handling: newlines become
    // carriage returns and, with the agent's bracketed-paste mode on (the
    // agent TUIs enable it), the whole prompt is wrapped in paste markers —
    // so a multi-line prompt lands in the agent's input box as one block
    // instead of submitting at its first line break.
    main.content.paste(prompt);
    await new Promise(resolve =>
      window.setTimeout(resolve, PASTE_SUBMIT_DELAY_MS)
    );
    if (main.isDisposed || main.content.isDisposed) {
      // The tab closed during the pause; the pasted text already reached the
      // session but Enter can no longer be delivered through this widget.
      throw new Error(
        this._trans.__('The terminal closed before the prompt was submitted.')
      );
    }
    main.content.session.send({ type: 'stdin', content: ['\r'] });
  }

  private _findWidget(name: string): TerminalWidget | null {
    return (
      this._tracker.find(widget => widget.content.session.name === name) ?? null
    );
  }

  private _registry: SessionRegistry;
  private _tracker: ITerminalTracker;
  private _commands: CommandRegistry;
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

    /** Tracker of open terminal widgets, to find the target's tab. */
    tracker: ITerminalTracker;

    /** The application command registry, for `terminal:open`/`create-new`. */
    commands: CommandRegistry;

    /** The terminal session manager, for the pre-send liveness check. */
    terminals: Terminal.IManager;

    /** Names to detect — same list the registry polls with. */
    detectCommands: () => string[];

    /** Whether a detected command belongs to a coding agent (not an editor). */
    isAgentCommand: (command: string) => boolean;

    /** Translation bundle for the error messages thrown to callers. */
    trans: TranslationBundle;
  }
}
