import { Token } from '@lumino/coreutils';
import type { ISignal } from '@lumino/signaling';

/**
 * Command opening (or activating) the transcript view of an external
 * session; takes `{ id }`.
 */
export const TRANSCRIPT_COMMAND = 'xtralab:external-agent-transcript';

/**
 * Command opening a new terminal attached to an external session; takes
 * `{ id }`.
 */
export const ATTACH_COMMAND = 'xtralab:external-agent-attach';

/**
 * One coding-agent session running outside JupyterLab's own terminals, in
 * the open folder or a folder inside it, as the server reports it.
 */
export interface IExternalAgentSession {
  /**
   * Stable handle, `<agent>:<session id>` — the key for every other call.
   */
  id: string;

  /**
   * The agent, matching the launcher's ids: `claude`, `codex`, `pi`.
   */
  agent: string;

  /**
   * Absolute working directory of the agent process.
   */
  cwd: string;

  /**
   * `cwd` relative to the server root, or `null` for the root itself.
   */
  subpath: string | null;

  /**
   * Short name the agent gave the session (falls back to a short id).
   */
  name: string;

  /**
   * The agent's own title for the conversation, when it generated one.
   */
  title: string | null;

  /**
   * `busy`, `idle` or `unknown`.
   */
  status: string;

  /**
   * Preview of the latest user prompt, when the transcript is readable.
   */
  lastPrompt: string | null;

  /**
   * Process id of the agent, when known.
   */
  pid: number | null;

  /**
   * The agent's own session or thread id, when known.
   */
  sessionId: string | null;

  /**
   * Unix time (seconds) the process started, when known.
   */
  startedAt: number | null;

  /**
   * Whether a transcript can be replayed for this session.
   */
  transcript: boolean;

  /**
   * Whether a prompt can be delivered to the running process.
   */
  send: boolean;

  /**
   * Shell command that attaches a new terminal to the session, or `null`
   * when the agent offers no way in.
   */
  attach: string | null;
}

/**
 * One normalized transcript entry, agent-agnostic.
 */
export interface ITranscriptEntry {
  /**
   * `user`, `assistant`, `tool` (a call), `result` (its output), `status`
   * (`busy`/`idle` marker) or `title` (metadata, not shown in the list).
   */
  kind: string;

  /**
   * The entry text: message body, tool input summary or tool output.
   */
  text: string;

  /**
   * Tool name for `tool`; `error` on a failed `result`.
   */
  name?: string;

  /**
   * ISO timestamp when the agent recorded one.
   */
  ts?: string;

  /**
   * The agent's id for a tool call, shared by its `tool` and `result` entries
   * so the output can be shown with the call.
   */
  callId?: string;

  /**
   * The structured input of a `tool` entry, as the agent recorded it, with
   * long strings clipped.
   */
  input?: unknown;
}

/**
 * The external agent sessions, polled from the server, and the actions on
 * them: replay a transcript, send a prompt, attach a terminal.
 */
export interface IExternalAgents {
  /**
   * Snapshot of the sessions the last poll reported.
   */
  sessions(): IExternalAgentSession[];

  /**
   * The session with this id, or `null`.
   */
  find(id: string): IExternalAgentSession | null;

  /**
   * Emitted whenever the {@link sessions} snapshot changed.
   */
  readonly changed: ISignal<IExternalAgents, void>;

  /**
   * Poll the server now instead of waiting for the next tick.
   */
  refresh(): Promise<void>;

  /**
   * Deliver `prompt` to the session's running process. Rejects with the
   * server's explanation when the agent has no way in.
   */
  sendPrompt(id: string, prompt: string): Promise<void>;

  /**
   * Open the session's conversation in the main area, or activate it.
   * `label` names the tab when the session is no longer listed (restore).
   */
  openTranscript(id: string, label?: string): Promise<void>;

  /**
   * Open a new terminal running the session's attach command.
   */
  attach(id: string): Promise<void>;
}

/**
 * DI token for {@link IExternalAgents}. Provided by
 * `xtralab:external-agents`; the terminals panel and ask-agent consume it
 * optionally, so either side works without the other.
 */
export const IExternalAgents = new Token<IExternalAgents>(
  'xtralab:IExternalAgents',
  'The coding-agent sessions running outside JupyterLab in the open folder, with transcript replay and prompt delivery.'
);
