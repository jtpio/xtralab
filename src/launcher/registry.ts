import { ISignal, Signal } from '@lumino/signaling';

import type { IAgent } from './agents';
import type { IAgentRegistry } from './tokens';

/**
 * Concrete {@link IAgentRegistry} the launcher plugin provides. The launcher
 * is the only writer, so {@link setAgents} is kept off the shared token.
 */
export class AgentRegistry implements IAgentRegistry {
  /**
   * The current agents, filtered by availability and sorted by rank.
   */
  get agents(): IAgent[] {
    return this._agents;
  }

  /**
   * Emitted whenever {@link agents} changes.
   */
  get changed(): ISignal<IAgentRegistry, void> {
    return this._changed;
  }

  /**
   * Replace the agent list and notify observers.
   */
  setAgents(agents: IAgent[]): void {
    this._agents = agents;
    this._changed.emit();
  }

  private _agents: IAgent[] = [];
  private _changed = new Signal<IAgentRegistry, void>(this);
}
