import type { IStateDB } from '@jupyterlab/statedb';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';

export type RecentKind = 'command' | 'file';

/**
 * A single recorded use: a command that was run or a file that was opened.
 */
interface IRecentEntry {
  kind: RecentKind;
  /**
   * The command id, or the workspace-relative file path.
   */
  id: string;
  args?: ReadonlyPartialJSONObject;
}

/**
 * Identity of an entry: two uses only match when kind, id and args all do, so
 * runs of one command with different args stay distinct.
 */
function entryKey(entry: IRecentEntry): string {
  return `${entry.kind}\0${entry.id}\0${JSON.stringify(entry.args ?? null)}`;
}

const STATE_KEY = 'xtralab:omnibox:recents';

/**
 * A most-recently-used list of omnibox results, most-recent-first, capped at
 * `maxItems` per kind and persisted through the state database. Without a
 * state database it still works for the lifetime of the page.
 */
export class OmniboxRecents {
  constructor(options: OmniboxRecents.IOptions = {}) {
    this._state = options.state ?? null;
  }

  /**
   * Maximum entries kept per kind; lowering trims immediately, `0` disables recents.
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
   * The recorded entries, most recent first, optionally filtered to one kind.
   */
  entries(kind?: RecentKind): IRecentEntry[] {
    return kind
      ? this._entries.filter(entry => entry.kind === kind)
      : [...this._entries];
  }

  /**
   * Record a use, moving the entry to the front of its kind's list.
   */
  touch(kind: RecentKind, id: string, args?: ReadonlyPartialJSONObject): void {
    const entry: IRecentEntry =
      args === undefined ? { kind, id } : { kind, id, args };
    const key = entryKey(entry);
    const rest = this._entries.filter(existing => entryKey(existing) !== key);
    this._entries = this._trim([entry, ...rest]);
    this._save();
  }

  /**
   * Load the persisted list. Entries recorded before the load completes stay
   * ahead of the restored history.
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
      ? fetched.filter((entry): entry is IRecentEntry => {
          if (!entry || typeof entry !== 'object') {
            return false;
          }
          const candidate = entry as IRecentEntry;
          if (candidate.kind !== 'command' && candidate.kind !== 'file') {
            return false;
          }
          if (typeof candidate.id !== 'string') {
            return false;
          }
          const args: unknown = candidate.args;
          return (
            args === undefined ||
            (typeof args === 'object' && args !== null && !Array.isArray(args))
          );
        })
      : [];
    const known = new Set(this._entries.map(entryKey));
    const merged = [...this._entries];
    for (const entry of persisted) {
      const key = entryKey(entry);
      if (!known.has(key)) {
        known.add(key);
        merged.push(
          entry.args === undefined
            ? { kind: entry.kind, id: entry.id }
            : { kind: entry.kind, id: entry.id, args: entry.args }
        );
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
    const value = this._entries.map<ReadonlyPartialJSONObject>(entry =>
      entry.args === undefined
        ? { kind: entry.kind, id: entry.id }
        : { kind: entry.kind, id: entry.id, args: entry.args }
    );
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
    state?: IStateDB | null;
  }
}
