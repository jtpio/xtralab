import type { IDisposable } from '@lumino/disposable';
import { Poll } from '@lumino/polling';
import { ISignal, Signal } from '@lumino/signaling';

import { fetchExternalSessions } from './api';
import type { IExternalAgentSession } from './tokens';

const POLL_INTERVAL_MS = 3000;

const POLL_MAX_MS = 60_000;

/**
 * The polled list of external sessions. A failed poll keeps the previous
 * snapshot, so a transient server error does not empty the panel.
 */
export class ExternalAgentsModel implements IDisposable {
  constructor() {
    this._poll = new Poll({
      name: '@xtralab/external-agents:sessions',
      factory: () => this._refresh(),
      frequency: {
        interval: POLL_INTERVAL_MS,
        backoff: true,
        max: POLL_MAX_MS
      },
      standby: 'when-hidden'
    });
  }

  /**
   * Emitted whenever the snapshot changed.
   */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * Whether the model has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Snapshot of the sessions the last successful poll reported.
   */
  sessions(): IExternalAgentSession[] {
    return this._sessions;
  }

  /**
   * The session with this id, or `null`.
   */
  find(id: string): IExternalAgentSession | null {
    return this._sessions.find(session => session.id === id) ?? null;
  }

  /**
   * Poll now; resolves once the snapshot is updated.
   */
  async refresh(): Promise<void> {
    await this._poll.refresh();
    await this._poll.tick;
  }

  /**
   * Dispose of the poll and signal connections.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._poll.dispose();
    Signal.clearData(this);
  }

  private async _refresh(): Promise<void> {
    const sessions = await fetchExternalSessions();
    if (sessions === null) {
      // Rejecting makes the poll back off; the last snapshot stays.
      throw new Error('external agent listing unavailable');
    }
    const serialized = JSON.stringify(sessions);
    if (serialized !== this._serialized) {
      this._serialized = serialized;
      this._sessions = sessions;
      this._changed.emit();
    }
  }

  private _poll: Poll;
  private _sessions: IExternalAgentSession[] = [];
  private _serialized = '[]';
  private _isDisposed = false;
  private _changed = new Signal<this, void>(this);
}
