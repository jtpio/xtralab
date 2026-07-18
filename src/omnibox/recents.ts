import type { IStateDB } from '@jupyterlab/statedb';
import type { PartialJSONObject } from '@lumino/coreutils';

/**
 * Kinds of omnibox results whose uses are recorded.
 */
export type RecentKind = 'command' | 'file';

/**
 * A single recorded use: a command that was run or a file that was opened.
 */
export interface IRecentEntry {
  kind: RecentKind;
  /**
   * The command id, or the workspace-relative file path.
   */
  id: string;
}

/**
 * State database key the recents list is persisted under.
 */
const STATE_KEY = 'xtralab:omnibox:recents';

/**
 * A most-recently-used list of omnibox results, generic over the result kind
 * so commands and files (and future kinds) share one store. Entries are kept
 * most-recent-first, capped at `maxItems` per kind, and persisted through the
 * state database so they survive reloads. Without a state database the list
 * still works for the lifetime of the page.
 */
export class OmniboxRecents {
  constructor(options: OmniboxRecents.IOptions = {}) {
    this._state = options.state ?? null;
  }

  /**
   * Maximum number of entries remembered per kind. Lowering it trims the list
   * immediately; `0` disables recents entirely.
   */
  get maxItems(): number {
    return this._maxItems;
  }
  set maxItems(value: number) {
    const normalized = Math.max(0, Math.floor(value));
    if (normalized === this._maxItems) {
      return;
    }
    this._maxItems = normalized;
    const trimmed = this._trim(this._entries);
    if (trimmed.length !== this._entries.length) {
      this._entries = trimmed;
      this._save();
    }
  }

  /**
   * The recorded entries, most recent first — all of them, or only those of
   * one kind.
   */
  entries(kind?: RecentKind): IRecentEntry[] {
    return kind
      ? this._entries.filter(entry => entry.kind === kind)
      : [...this._entries];
  }

  /**
   * Record a use of `id`, moving it to the front of its kind's list.
   */
  touch(kind: RecentKind, id: string): void {
    const rest = this._entries.filter(
      entry => !(entry.kind === kind && entry.id === id)
    );
    this._entries = this._trim([{ kind, id }, ...rest]);
    this._save();
  }

  /**
   * Load the persisted list. Entries recorded before the load completes stay
   * at the front, ahead of the restored history.
   */
  async restore(): Promise<void> {
    if (!this._state) {
      return;
    }
    let fetched: unknown;
    try {
      fetched = await this._state.fetch(STATE_KEY);
    } catch {
      return;
    }
    const persisted: IRecentEntry[] = Array.isArray(fetched)
      ? fetched.filter(
          (entry): entry is IRecentEntry =>
            !!entry &&
            typeof entry === 'object' &&
            ((entry as IRecentEntry).kind === 'command' ||
              (entry as IRecentEntry).kind === 'file') &&
            typeof (entry as IRecentEntry).id === 'string'
        )
      : [];
    const merged = [...this._entries];
    for (const entry of persisted) {
      if (
        !merged.some(
          existing => existing.kind === entry.kind && existing.id === entry.id
        )
      ) {
        merged.push({ kind: entry.kind, id: entry.id });
      }
    }
    this._entries = this._trim(merged);
  }

  /**
   * Keep at most `maxItems` entries of each kind, preserving order.
   */
  private _trim(entries: IRecentEntry[]): IRecentEntry[] {
    const counts = new Map<RecentKind, number>();
    return entries.filter(entry => {
      const count = counts.get(entry.kind) ?? 0;
      counts.set(entry.kind, count + 1);
      return count < this._maxItems;
    });
  }

  private _save(): void {
    if (!this._state) {
      return;
    }
    const value = this._entries.map<PartialJSONObject>(entry => ({
      kind: entry.kind,
      id: entry.id
    }));
    this._state.save(STATE_KEY, value).catch(reason => {
      console.error('xtralab omnibox: failed to save recents', reason);
    });
  }

  private _state: IStateDB | null;
  private _entries: IRecentEntry[] = [];
  private _maxItems = 5;
}

export namespace OmniboxRecents {
  /**
   * Construction options for {@link OmniboxRecents}.
   */
  export interface IOptions {
    /**
     * The state database to persist through, if available.
     */
    state?: IStateDB | null;
  }
}
