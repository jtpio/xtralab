import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';

import type { IAgent } from './agents';
import type { IAgentRegistry } from './tokens';

/**
 * Concrete {@link IAgentRegistry} the launcher plugin provides. The launcher
 * sets the configured agents with {@link setAgents}, kept off the shared
 * token; other plugins add theirs with {@link addAgent}.
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
   * Replace the configured agents and notify observers.
   */
  setAgents(agents: IAgent[]): void {
    this._configured = agents;
    this._update();
  }

  /**
   * Add an agent next to the configured ones.
   */
  addAgent(agent: IAgent): IDisposable {
    this._added.push(agent);
    this._update();
    return new DisposableDelegate(() => {
      const index = this._added.indexOf(agent);
      if (index !== -1) {
        this._added.splice(index, 1);
        this._update();
      }
    });
  }

  private _update(): void {
    // A configured agent wins over an added one with the same id.
    const byId = new Map<string, IAgent>();
    for (const agent of [...this._configured, ...this._added]) {
      if (!byId.has(agent.id)) {
        byId.set(agent.id, agent);
      }
    }
    this._agents = [...byId.values()].sort((a, b) => a.rank - b.rank);
    this._changed.emit();
  }

  private _agents: IAgent[] = [];
  private _configured: IAgent[] = [];
  private _added: IAgent[] = [];
  private _changed = new Signal<IAgentRegistry, void>(this);
}
