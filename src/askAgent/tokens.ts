import { Token } from '@lumino/coreutils';

/**
 * The command id that opens the ask-agent popup for the current text-editor
 * selection. Registered by `xtralab:ask-agent`; exposed here so menus and
 * other plugins can reference it without importing the plugin internals.
 */
export const ASK_AGENT_COMMAND = 'xtralab:ask-agent';

/**
 * A code location (and optionally the selected source text) that a prompt
 * should point an agent at. The structured fields are composed into the
 * final prompt by the ask-agent plugin so every entry point — editor
 * selection, diff line selection — produces consistently worded prompts.
 */
export interface IAskAgentContext {
  /**
   * Path of the file the selection belongs to, relative to {@link cwd} (or
   * to the server root when no cwd is given) so the launched agent can open
   * it directly.
   */
  path: string;

  /**
   * Server-relative directory the agent's terminal starts in. Omit to start
   * in the server root. Diff selections pass the git repository root here so
   * the agent can run git commands right away.
   */
  cwd?: string;

  /**
   * The notebook cell the selection lives in, when {@link path} is a
   * notebook. `index` is the cell's 0-based position in the nbformat
   * `cells` array; `type` is the nbformat cell type (`code`, `markdown`,
   * `raw`). When set, {@link startLine}/{@link endLine} count within the
   * cell's source rather than within a file.
   */
  cell?: {
    index: number;
    type: string;
  };

  /**
   * First selected line, 1-indexed and inclusive. Omit when no line range is
   * known (the prompt then only references the file).
   */
  startLine?: number;

  /**
   * Last selected line, 1-indexed and inclusive. Defaults to
   * {@link startLine} when omitted.
   */
  endLine?: number;

  /**
   * The selected source text. May be empty when only a location is known;
   * the prompt then relies on the path and line range alone.
   */
  text: string;

  /**
   * Extra agent-facing locator appended after the line range in the prompt,
   * e.g. `the old side (INDEX) of the git diff`. Written in English because
   * it is consumed by the agent, not shown in the UI.
   */
  location?: string;

  /**
   * Short user-facing tag shown in the popup header next to the file name,
   * e.g. "old side". Translated, unlike {@link location}.
   */
  note?: string;
}

/**
 * Where a submitted prompt goes: a fresh terminal started with the chosen
 * agent's command, or an existing terminal session whose running agent
 * receives the prompt in its input box (queued by the agent itself when it
 * is busy).
 */
export type AskAgentTarget =
  | { kind: 'new'; agentId: string }
  | { kind: 'session'; name: string };

/**
 * A request to open the ask-agent popup: what code to prompt about and
 * where to place the popup on screen.
 */
export interface IAskAgentRequest {
  context: IAskAgentContext;

  /**
   * Viewport rectangle the popup anchors to (typically the selection end or
   * the button that was clicked). `null` positions the popup near the top
   * center of the viewport.
   */
  anchor: DOMRect | null;
}

/**
 * The ask-agent popup: a small floating prompt box that sends the given
 * code selection, plus the user's typed instruction, to one of the
 * configured coding agents — in a fresh terminal, or into an agent already
 * running in an existing one.
 */
export interface IAskAgent {
  /**
   * Open the popup for `request`, replacing any popup already open.
   */
  open(request: IAskAgentRequest): void;

  /**
   * Close the popup if it is open.
   */
  close(): void;
}

/**
 * DI token for {@link IAskAgent}. Provided by `xtralab:ask-agent` and
 * consumed — optionally, so diffs still render when the plugin is disabled —
 * by the git diff plugins to offer "ask an agent about these lines".
 */
export const IAskAgent = new Token<IAskAgent>(
  'xtralab:IAskAgent',
  'A floating prompt box that sends the current code selection to a coding agent running in a terminal.'
);
