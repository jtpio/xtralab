import { Token } from '@lumino/coreutils';
import type { ISignal } from '@lumino/signaling';

import type { IAgent } from './agents';
import type { IEditor } from './editors';

/**
 * A read-only, observable view of the launcher's shared state: the available
 * agents and the configured editors.
 *
 * The launcher plugin owns both lists — xtralab's defaults merged with the
 * user's `xtralab:launcher` settings, then filtered by a server-side `which`
 * check — and registers an `xtralab:start-agent:<id>` command for each agent.
 * This token shares those lists, and (via {@link agentCommandId}) the command
 * id that launches each agent, so other plugins can surface the same agents
 * and editors without re-deriving them or duplicating the icons. The terminals
 * panel uses the agents to build its "new terminal" dropdown, and both lists
 * to badge running sessions with the right logo.
 */
export interface IAgentRegistry {
  /**
   * The current agents, already filtered by availability and sorted by
   * rank — the same array the launcher renders.
   */
  readonly agents: IAgent[];

  /**
   * The current editors — xtralab's built-ins (Neovim, Vim) merged with the
   * user's `editors` setting and sorted by rank, with disabled entries
   * removed. This is the full list, not the single tile the launcher shows
   * (the launcher resolves that via `resolveEditor`): the terminals panel uses
   * it to badge a row for any configured editor that is running, and to tell
   * the server which editor commands to detect.
   */
  readonly editors: IEditor[];

  /**
   * Emitted whenever {@link agents} or {@link editors} changes (e.g. the user
   * edits the launcher settings). Consumers that cache a list should re-read
   * it here; consumers that read it on demand can ignore the signal.
   */
  readonly changed: ISignal<IAgentRegistry, void>;
}

/**
 * DI token for {@link IAgentRegistry}. Provided by `xtralab:launcher` and
 * consumed — optionally, so the panel still works when the launcher is
 * disabled — by `xtralab:terminals`.
 */
export const IAgentRegistry = new Token<IAgentRegistry>(
  'xtralab:IAgentRegistry',
  'A read-only, observable view of the launcher agents, shared so other plugins can offer the same agent list and icons.'
);

/**
 * The JupyterLab command id that launches a given agent in a new terminal.
 * Defined here — in the shared contract module rather than the launcher's
 * command-registration internals — so the launcher (which registers the
 * commands) and any consumer (which references them, e.g. in a menu) agree
 * on the id.
 */
export function agentCommandId(agentId: string): string {
  return `xtralab:start-agent:${agentId}`;
}
