import { Token } from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';

import type { IAgent } from './agents';

/**
 * An observable view of the launcher's available agents — the merged,
 * availability-filtered list the launcher renders — shared so other plugins
 * (e.g. the terminals panel) can surface the same agents and icons, and add
 * their own.
 */
export interface IAgentRegistry {
  /**
   * The current agents, filtered by availability and sorted by rank.
   */
  readonly agents: IAgent[];

  /**
   * Emitted whenever {@link agents} changes.
   */
  readonly changed: ISignal<IAgentRegistry, void>;

  /**
   * Add an agent next to the configured ones, for example a chat persona
   * that sets {@link IAgent.start}. The launcher, the omnibox and the
   * ask-agent popup offer it; disposing the result removes it.
   */
  addAgent(agent: IAgent): IDisposable;
}

/**
 * DI token for {@link IAgentRegistry}. Provided by `xtralab:launcher`;
 * consumers depend on it optionally so they survive the launcher being
 * disabled.
 */
export const IAgentRegistry = new Token<IAgentRegistry>(
  'xtralab:IAgentRegistry',
  'An observable view of the launcher agents, shared so other plugins can offer the same agent list and icons, and add agents.'
);

/**
 * The command id that launches a given agent in a new terminal, defined in
 * the shared contract module so the launcher and consumers agree on it.
 */
export function agentCommandId(agentId: string): string {
  return `xtralab:start-agent:${agentId}`;
}
