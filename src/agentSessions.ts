import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

/**
 * A shared map from a terminal session name to the agent command it was
 * *launched* with (e.g. `claude`).
 *
 * This is the optimistic half of the running-agent badge: when the launcher
 * (or the terminals panel's `+` menu) starts an agent via a
 * `xtralab:start-agent:<id>` command, it records the session here so the
 * panel can show the agent's logo immediately, before the server-side
 * process detection has had a chance to confirm it. Server detection is the
 * authoritative source once it reports on a session; this tag only fills the
 * gap right after launch (and serves as a fallback if detection is
 * unavailable).
 *
 * It exists as its own token, provided by a tiny dependency-free plugin,
 * specifically so the launcher (the writer) and the terminals panel (the
 * reader) can share it without depending on each other — a direct
 * launcher↔terminals token pair would form an activation cycle.
 */
export interface IAgentSessions {
  /**
   * The agent command a session was launched with, or `null` if we never
   * launched an agent into it (e.g. a plain terminal, or one started before
   * this ran).
   */
  get(sessionName: string): string | null;

  /** Record that a session was launched as the given agent command. */
  set(sessionName: string, command: string): void;

  /** Forget a session — called when it shuts down so the map stays bounded. */
  delete(sessionName: string): void;

  /**
   * Emitted with the affected session name whenever a record is added or
   * removed, so readers can re-render.
   */
  readonly changed: ISignal<IAgentSessions, string>;
}

/**
 * DI token for {@link IAgentSessions}. Provided by `xtralab:agent-sessions`;
 * consumed (optionally) by both `xtralab:launcher` and `xtralab:terminals`.
 */
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
 * Provides {@link IAgentSessions}. Deliberately has no dependencies so it can
 * sit underneath both the launcher and the terminals panel without creating
 * a dependency cycle between them.
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
