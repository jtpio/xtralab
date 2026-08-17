import { Token } from '@lumino/coreutils';

/**
 * Command id opening the ask-agent popup for the current editor selection;
 * exposed so other plugins can reference it without the plugin internals.
 */
export const ASK_AGENT_COMMAND = 'xtralab:ask-agent';

/**
 * A code location (and optionally the selected text) a prompt should point
 * an agent at; the plugin composes the fields into consistently worded
 * prompts for every entry point.
 */
export interface IAskAgentContext {
  /**
   * Path of the file, relative to {@link cwd} (or to the server root when
   * no cwd is given).
   */
  path: string;

  /**
   * Server-relative directory the agent's terminal starts in. Diff
   * selections pass the git repository root so the agent can run git
   * commands right away.
   */
  cwd?: string;

  /**
   * The notebook cell the selection lives in. `index` is the 0-based
   * nbformat position, `type` the nbformat cell type; when set,
   * {@link startLine}/{@link endLine} count within the cell's source.
   */
  cell?: {
    index: number;
    type: string;
  };

  /**
   * First selected line, 1-indexed and inclusive. Omit when no line range
   * is known.
   */
  startLine?: number;

  /**
   * Last selected line, 1-indexed and inclusive. Defaults to
   * {@link startLine} when omitted.
   */
  endLine?: number;

  /**
   * Whether the lines index the file's current working-tree content.
   * `false` for diff selections taken from another revision, whose numbers
   * must not highlight the working file. Omitted means `true`.
   */
  linesInWorkingFile?: boolean;

  /**
   * The selected source text; may be empty when only a location is known.
   */
  text: string;

  /**
   * Extra agent-facing locator appended after the line range, e.g. `the old
   * side (INDEX) of the git diff`. English — consumed by the agent, not the UI.
   */
  location?: string;

  /**
   * Short user-facing tag shown in the popup header, e.g. "old version".
   * Translated, unlike {@link location}.
   */
  note?: string;
}

/**
 * Where a submitted prompt goes: a fresh terminal started with the chosen
 * agent's command, or an existing session whose running agent receives the
 * prompt in its input box (queued by the agent itself when busy).
 */
export type AskAgentTarget =
  | { kind: 'new'; agentId: string }
  | { kind: 'session'; name: string };

/**
 * A request to open the ask-agent popup: what code to prompt about and
 * where to place the popup on screen.
 */
export interface IAskAgentRequest {
  /**
   * The code location and selection the prompt is about.
   */
  context: IAskAgentContext;

  /**
   * Viewport rectangle the popup anchors to; `null` positions it near the
   * top center of the viewport.
   */
  anchor: DOMRect | null;
}

/**
 * The ask-agent popup: a floating prompt box that sends the given code
 * selection plus the user's instruction to a coding agent, in a fresh or
 * running terminal.
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
 * DI token for {@link IAskAgent}; consumed optionally by the git diff
 * plugins so diffs still render when the plugin is disabled.
 */
export const IAskAgent = new Token<IAskAgent>(
  'xtralab:IAskAgent',
  'A floating prompt box that sends the current code selection to a coding agent running in a terminal.'
);
