import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

/**
 * Shared map from terminal session name to the agent command it was launched
 * with — the optimistic half of the running-agent badge, shown until server
 * detection confirms. Its own token so the launcher (writer) and terminals
 * panel (reader) can share it without an activation cycle.
 */
export interface IAgentSessions {
  /**
   * The agent command a session was launched with, or `null` if unknown.
   */
  get(sessionName: string): string | null;

  /**
   * Record that a session was launched as the given agent command.
   */
  set(sessionName: string, command: string): void;

  /**
   * Forget a session so the map stays bounded.
   */
  delete(sessionName: string): void;

  /**
   * Emitted with the session name whenever a record is added or removed.
   */
  readonly changed: ISignal<IAgentSessions, string>;
}

export const IAgentSessions = new Token<IAgentSessions>(
  'xtralab:IAgentSessions',
  'A shared map from terminal session name to the agent command it was launched with.'
);

class AgentSessions implements IAgentSessions {
  get(sessionName: string): string | null {
    return this._byName.get(sessionName) ?? null;
  }

  set(sessionName: string, command: string): void {
    if (this._byName.get(sessionName) === command) {
      return;
    }
    this._byName.set(sessionName, command);
    this._changed.emit(sessionName);
  }

  delete(sessionName: string): void {
    if (this._byName.delete(sessionName)) {
      this._changed.emit(sessionName);
    }
  }

  get changed(): ISignal<IAgentSessions, string> {
    return this._changed;
  }

  private _byName = new Map<string, string>();
  private _changed = new Signal<IAgentSessions, string>(this);
}

/**
 * Provides {@link IAgentSessions}; dependency-free so it can sit underneath
 * both the launcher and the terminals panel.
 */
const plugin: JupyterFrontEndPlugin<IAgentSessions> = {
  id: 'xtralab:agent-sessions',
  description:
    'Shared map from terminal session to the agent command it was launched with, used to badge terminal rows with the running agent.',
  autoStart: true,
  provides: IAgentSessions,
  activate: (): IAgentSessions => new AgentSessions()
};

export default plugin;
