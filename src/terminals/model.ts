import type { MainAreaWidget } from '@jupyterlab/apputils';
import type { ServiceManager, Terminal } from '@jupyterlab/services';
import type { ITerminal, ITerminalTracker } from '@jupyterlab/terminal';
import type { IDisposable } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';
import type { Title, Widget } from '@lumino/widgets';

/**
 * The widget shape every entry in `ITerminalTracker` takes — kept here
 * so the registry's call sites read cleanly.
 */
export type TerminalWidget = MainAreaWidget<ITerminal.ITerminal>;

/**
 * Source-of-truth model for the running-terminals panel. Each running
 * terminal session known to the server is one entry; the registry caches
 * the last `widget.title.label` we observed so the agent name (or any
 * xterm-published title) survives the user closing the tab while the
 * session continues running on the backend.
 *
 * Two upstream signals feed the model:
 *   - `serviceManager.terminals.runningChanged` is the authoritative
 *     list of live sessions; everything not in it has been shut down
 *     server-side and we must drop it.
 *   - `tracker.widgetAdded` plus the per-widget `title.changed` /
 *     `disposed` signals keep our label cache in sync with whatever
 *     xterm/the launcher has set on the open tabs.
 *
 * `stateChanged` is emitted for both kinds of update; the panel hooks it
 * through a `UseSignal` so a single subscription re-renders the list on
 * either change.
 */
export class SessionRegistry implements IDisposable {
  constructor(
    serviceManager: ServiceManager.IManager,
    tracker: ITerminalTracker
  ) {
    this._terminals = serviceManager.terminals;
    this._tracker = tracker;

    this._terminals.runningChanged.connect(this._onRunningChanged, this);
    this._tracker.widgetAdded.connect(this._onWidgetAdded, this);
    this._tracker.forEach(widget => this._trackWidget(widget));
    this._refreshLive();
  }

  /**
   * Emitted whenever the live session list or any cached label changes.
   */
  get stateChanged(): ISignal<this, void> {
    return this._stateChanged;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Names of all live sessions, ordered by their stable rank so the
   * rendered list keeps a consistent order (roughly creation order) as
   * new sessions are added and old ones shut down.
   */
  sessionNames(): string[] {
    const names = Array.from(this._live);
    names.sort((a, b) => this.rankFor(a) - this.rankFor(b));
    return names;
  }

  /**
   * True iff the named session is still on the server. Used by the panel
   * to skip a row during the brief window between the session's shutdown
   * and the next `runningChanged` arriving.
   */
  has(name: string): boolean {
    return this._live.has(name);
  }

  /**
   * Display name for the session. The cache wins because it only
   * holds "real" labels (the launcher's agent name or an xterm escape
   * sequence — see `_cacheLabel` for the filter); reading it first
   * prevents the transient `Terminal {name}` an XTerm widget shows
   * during reconnect from flickering into the panel. The live widget
   * title is used when no cache exists, and the `Terminal {name}`
   * fallback covers sessions we have never seen a widget for (e.g.
   * surviving a lab reload).
   */
  labelFor(name: string): string {
    const cached = this._labels.get(name);
    if (cached) {
      return cached;
    }
    const widget = this.widgetFor(name);
    if (widget && widget.title.label) {
      return widget.title.label;
    }
    return `Terminal ${name}`;
  }

  /**
   * Return the open widget for a session, if any. The panel uses this to
   * switch behaviour between "activate existing tab" and "open a new tab
   * connected to the live session".
   */
  widgetFor(name: string): TerminalWidget | null {
    return (
      this._tracker.find(widget => widget.content.session.name === name) ?? null
    );
  }

  /**
   * Stable per-session rank assigned in observation order. Used to keep
   * the rendered list in a steady order so rows don't reshuffle as
   * sessions come and go. Cleaned up when the session is shut down so the
   * counter does not grow without bound across long sessions.
   */
  rankFor(name: string): number {
    let rank = this._ranks.get(name);
    if (rank === undefined) {
      rank = this._nextRank++;
      this._ranks.set(name, rank);
    }
    return rank;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._terminals.runningChanged.disconnect(this._onRunningChanged, this);
    this._tracker.widgetAdded.disconnect(this._onWidgetAdded, this);
    this._tracker.forEach(widget => this._untrackWidget(widget));
    Signal.clearData(this);
  }

  private _refreshLive(): void {
    const next = new Set<string>();
    for (const model of this._terminals.running()) {
      next.add(model.name);
    }
    this._live = next;
    // Drop cache + rank entries for sessions that have been shut down
    // server-side. Without this prune the rank counter would keep
    // climbing across long-running labs as terminals come and go.
    for (const name of Array.from(this._labels.keys())) {
      if (!next.has(name)) {
        this._labels.delete(name);
      }
    }
    for (const name of Array.from(this._ranks.keys())) {
      if (!next.has(name)) {
        this._ranks.delete(name);
      }
    }
  }

  private _onRunningChanged(_: unknown, sessions: Terminal.IModel[]): void {
    this._live = new Set(sessions.map(model => model.name));
    for (const name of Array.from(this._labels.keys())) {
      if (!this._live.has(name)) {
        this._labels.delete(name);
      }
    }
    for (const name of Array.from(this._ranks.keys())) {
      if (!this._live.has(name)) {
        this._ranks.delete(name);
      }
    }
    this._stateChanged.emit();
  }

  private _onWidgetAdded(_: unknown, widget: TerminalWidget): void {
    this._trackWidget(widget);
    this._stateChanged.emit();
  }

  private _trackWidget(widget: TerminalWidget): void {
    const name = widget.content.session.name;
    this._cacheLabel(name, widget.title.label);
    widget.title.changed.connect(this._onTitleChanged, this);
    widget.disposed.connect(this._onWidgetDisposed, this);
  }

  private _untrackWidget(widget: TerminalWidget): void {
    widget.title.changed.disconnect(this._onTitleChanged, this);
    widget.disposed.disconnect(this._onWidgetDisposed, this);
  }

  private _onTitleChanged(title: Title<Widget>): void {
    const owner = title.owner as TerminalWidget;
    const session = owner.content?.session;
    if (!session) {
      return;
    }
    this._cacheLabel(session.name, title.label);
    this._stateChanged.emit();
  }

  /**
   * Update the cached label for a session, but only when the new
   * label is "real" — non-empty and not one of the transient defaults
   * the XTerm widget cycles through during reconnect (`'...'` while
   * the websocket is opening, `'Terminal {name}'` once
   * `_initialConnection` fires). Without the filter, briefly
   * reopening a tab while an agent has yet to re-emit its xterm
   * title escape sequence would clobber the cached agent name with
   * `Terminal 1`, which is exactly the regression we are guarding
   * against. Live widget titles still display whatever the widget
   * currently holds because `labelFor` consults the widget first;
   * the filter only affects what survives a tab close.
   */
  private _cacheLabel(name: string, label: string): void {
    if (!label) {
      return;
    }
    if (label === '...' || label === `Terminal ${name}`) {
      return;
    }
    this._labels.set(name, label);
  }

  private _onWidgetDisposed(widget: Widget): void {
    // The widget is gone but the session may still be running on the
    // server — keep the cached label so the panel keeps the agent's name
    // when the user reopens the tab. We only clean up our subscriptions
    // here; the cache is purged by `runningChanged` once the session
    // itself goes away.
    this._untrackWidget(widget as TerminalWidget);
    this._stateChanged.emit();
  }

  private _terminals: Terminal.IManager;
  private _tracker: ITerminalTracker;
  private _labels = new Map<string, string>();
  private _ranks = new Map<string, number>();
  private _live = new Set<string>();
  private _nextRank = 100;
  private _isDisposed = false;
  private _stateChanged = new Signal<this, void>(this);
}
