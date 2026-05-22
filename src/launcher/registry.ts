import { ISignal, Signal } from '@lumino/signaling';

import type { IAgent } from './agents';
import type { IEditor } from './editors';
import type { IAgentRegistry } from './tokens';

/**
 * The concrete {@link IAgentRegistry} the launcher plugin provides on the
 * `IAgentRegistry` token. Holds the active agent and editor lists and re-emits
 * `changed` whenever the launcher recomputes them (on a settings change). The
 * launcher is the only writer, so the write side ({@link setAgents},
 * {@link setEditors}) is kept off the shared token.
 */
export class AgentRegistry implements IAgentRegistry {
  get agents(): IAgent[] {
    return this._agents;
  }

  get editors(): IEditor[] {
    return this._editors;
  }

  get changed(): ISignal<IAgentRegistry, void> {
    return this._changed;
  }

  /**
   * Replace the agent list and notify observers. Called by the launcher
   * after merging the user's settings and filtering by availability.
   */
  setAgents(agents: IAgent[]): void {
    this._agents = agents;
    this._changed.emit();
  }

  /**
   * Replace the editor list and notify observers. Called by the launcher
   * alongside {@link setAgents} after a settings change.
   */
  setEditors(editors: IEditor[]): void {
    this._editors = editors;
    this._changed.emit();
  }

  private _agents: IAgent[] = [];
  private _editors: IEditor[] = [];
  private _changed = new Signal<IAgentRegistry, void>(this);
}
