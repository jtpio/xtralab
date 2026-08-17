import { Token } from '@lumino/coreutils';
import type { ISignal } from '@lumino/signaling';

/**
 * One running terminal session with a confirmed coding agent inside — an
 * entry of {@link IAgentTerminals.sessions}.
 */
export interface IAgentTerminalSession {
  /**
   * The terminal session name (terminado's, e.g. `1`).
   */
  name: string;

  /**
   * The agent identifier detection reported: the configured `command`, or the
   * canonical `id` when the command is an alias (e.g. `ccm` spawning `claude`).
   */
  command: string;

  /**
   * Display label — the session's real (program-published) title.
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
 * Only sessions with a detection-*confirmed* running agent are listed — never
 * optimistic launch tags: pasted prompt text must land in an agent's TUI, not
 * a shell prompt where it would be executed.
 */
export interface IAgentTerminals {
  /**
   * Snapshot of the sessions with a detection-confirmed running agent.
   */
  sessions(): IAgentTerminalSession[];

  /**
   * Emitted whenever the {@link sessions} snapshot may have changed.
   */
  readonly changed: ISignal<IAgentTerminals, void>;

  /**
   * Paste `prompt` (bracketed-paste-wrapped) into the named session and press
   * Enter, writing straight to its websocket without revealing or focusing
   * its tab. Rejects when the session is gone or no agent runs in it anymore.
   */
  sendPrompt(name: string, prompt: string): Promise<void>;
}

/**
 * DI token for {@link IAgentTerminals}. Provided by `xtralab:terminals`;
 * consumed optionally by `xtralab:ask-agent`, so each side works without
 * the other.
 */
export const IAgentTerminals = new Token<IAgentTerminals>(
  'xtralab:IAgentTerminals',
  'The running terminal sessions with a detected coding agent, and a way to send a prompt into one.'
);
