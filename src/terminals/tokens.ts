import { Token } from '@lumino/coreutils';
import type { ISignal } from '@lumino/signaling';

/**
 * One running terminal session with a confirmed coding agent inside — an
 * entry of {@link IAgentTerminals.sessions}.
 */
export interface IAgentTerminalSession {
  /** The terminal session name (terminado's, e.g. `1`). */
  name: string;

  /**
   * The agent identifier server-side detection reported for the session:
   * the configured `command`, or the canonical agent `id` when the command
   * is an alias (e.g. `ccm` spawning `claude`). Matches an `IAgent` by
   * either field.
   */
  command: string;

  /**
   * Display label — the session's real title (the launcher's agent name, or
   * whatever the running program published via an xterm escape sequence).
   */
  label: string;

  /**
   * The latest meaningful line of the agent's output, when its tab is open
   * and the activity line is enabled; `null` otherwise.
   */
  activity: string | null;
}

/**
 * Running agent terminals, and a way to send a prompt into one.
 *
 * `sessions` only lists sessions where server-side process detection has
 * *confirmed* a running coding agent (editors and plain shells are excluded,
 * as are optimistic just-launched tags): every listed session is one whose
 * TUI can meaningfully receive pasted prompt text. `sendPrompt` re-validates
 * against the server before writing, since pasting prose into a shell prompt
 * would execute it.
 */
export interface IAgentTerminals {
  /** Snapshot of the sessions with a detection-confirmed running agent. */
  sessions(): IAgentTerminalSession[];

  /** Emitted whenever the {@link sessions} snapshot may have changed. */
  readonly changed: ISignal<IAgentTerminals, void>;

  /**
   * Paste `prompt` into the named session's terminal and press Enter.
   *
   * Reveals the session's tab (reopening one when it was closed), then
   * routes the text through xterm's paste handling so a multi-line prompt
   * arrives bracketed-paste-wrapped as one block in the agent's input box —
   * the agent CLIs queue it themselves when they are busy. Rejects when the
   * session is gone or no agent is running in it anymore.
   */
  sendPrompt(name: string, prompt: string): Promise<void>;
}

/**
 * DI token for {@link IAgentTerminals}. Provided by `xtralab:terminals`;
 * consumed — optionally, so each side works without the other — by
 * `xtralab:ask-agent` to offer running agent terminals as prompt targets.
 */
export const IAgentTerminals = new Token<IAgentTerminals>(
  'xtralab:IAgentTerminals',
  'The running terminal sessions with a detected coding agent, and a way to send a prompt into one.'
);
