import type { MainAreaWidget } from '@jupyterlab/apputils';
import type { ServiceManager, Terminal } from '@jupyterlab/services';
import type { ITerminal, ITerminalTracker } from '@jupyterlab/terminal';
import {
  type TranslationBundle,
  nullTranslator
} from '@jupyterlab/translation';
import {
  closeIcon,
  terminalIcon,
  VDomModel,
  VDomRenderer
} from '@jupyterlab/ui-components';
import type { Title, Widget } from '@lumino/widgets';
import * as React from 'react';

/**
 * The widget shape every entry in `ITerminalTracker` takes — kept here
 * so the registry's call sites read cleanly.
 */
export type TerminalWidget = MainAreaWidget<ITerminal.ITerminal>;

/**
 * Source-of-truth model for the status bar. Each running terminal
 * session known to the server is one entry; the registry caches the
 * last `widget.title.label` we observed so the agent name (or any
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
 * `stateChanged` is reused for both kinds of update so consumers
 * (the per-session status item, the plugin's add/remove sync) can
 * subscribe once.
 */
export class SessionRegistry extends VDomModel {
  constructor(
    serviceManager: ServiceManager.IManager,
    tracker: ITerminalTracker
  ) {
    super();
    this._terminals = serviceManager.terminals;
    this._tracker = tracker;

    this._terminals.runningChanged.connect(this._onRunningChanged, this);
    this._tracker.widgetAdded.connect(this._onWidgetAdded, this);
    this._tracker.forEach(widget => this._trackWidget(widget));
    this._refreshLive();
  }

  /**
   * Names of all live sessions, ordered by their stable rank so the
   * status bar items keep their slots as new sessions are added.
   */
  sessionNames(): string[] {
    const names = Array.from(this._live);
    names.sort((a, b) => this.rankFor(a) - this.rankFor(b));
    return names;
  }

  /**
   * True iff the named session is still on the server. Used by the
   * per-session item to render `null` during the brief window between
   * the session's shutdown and the plugin disposing the item.
   */
  has(name: string): boolean {
    return this._live.has(name);
  }

  /**
   * Display name for the session. The cache wins because it only
   * holds "real" labels (the launcher's agent name or an xterm escape
   * sequence — see `_cacheLabel` for the filter); reading it first
   * prevents the transient `Terminal {name}` an XTerm widget shows
   * during reconnect from flickering into the status bar. The live
   * widget title is used when no cache exists, and the
   * `Terminal {name}` fallback covers sessions we have never seen a
   * widget for (e.g. surviving a lab reload).
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
   * Return the open widget for a session, if any. The status item
   * uses this to switch behaviour between "activate existing tab"
   * and "open a new tab connected to the live session".
   */
  widgetFor(name: string): TerminalWidget | null {
    return (
      this._tracker.find(widget => widget.content.session.name === name) ?? null
    );
  }

  /**
   * Stable per-session rank assigned in observation order. Reused
   * across `registerStatusItem` calls so an item that is briefly
   * unregistered (e.g. while a widget is being recreated) lands back
   * in the same slot. Cleaned up when the session is shut down so the
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
    if (this.isDisposed) {
      return;
    }
    this._terminals.runningChanged.disconnect(this._onRunningChanged, this);
    this._tracker.widgetAdded.disconnect(this._onWidgetAdded, this);
    this._tracker.forEach(widget => this._untrackWidget(widget));
    super.dispose();
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
    this.stateChanged.emit();
  }

  private _onWidgetAdded(_: unknown, widget: TerminalWidget): void {
    this._trackWidget(widget);
    this.stateChanged.emit();
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
    this.stateChanged.emit();
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
    // server — keep the cached label so the status item keeps the
    // agent's name when the user reopens the tab. We only clean up
    // our subscriptions here; the cache is purged by `runningChanged`
    // once the session itself goes away.
    this._untrackWidget(widget as TerminalWidget);
    this.stateChanged.emit();
  }

  private _terminals: Terminal.IManager;
  private _tracker: ITerminalTracker;
  private _labels = new Map<string, string>();
  private _ranks = new Map<string, number>();
  private _live = new Set<string>();
  private _nextRank = 100;
}

/**
 * One status bar item per live terminal session. Renders a terminal
 * icon plus the session's label, with an inline shutdown button that
 * appears on hover/focus. The item delegates click handling to the
 * plugin so the lifecycle (create/dispose) and the user-facing
 * behaviour (activate vs. reopen, shutdown) live in one place.
 */
export class TerminalSessionItem extends VDomRenderer<SessionRegistry> {
  constructor(options: TerminalSessionItem.IOptions) {
    super(options.registry);
    this._sessionName = options.sessionName;
    this._trans = options.trans ?? nullTranslator.load('jupyterlab');
    this._onActivate = options.onActivate;
    this._onShutdown = options.onShutdown;
    this.addClass('jp-mod-highlighted');
    this.addClass('jp-xtralab-StatusBar-Terminal');
  }

  render(): React.ReactElement | null {
    if (!this.model || !this.model.has(this._sessionName)) {
      return null;
    }
    const trans = this._trans;
    const label = this.model.labelFor(this._sessionName);
    const hasWidget = this.model.widgetFor(this._sessionName) !== null;
    const tooltip = hasWidget
      ? trans.__('Activate %1', label)
      : trans.__('Reopen %1', label);
    this.node.title = tooltip;

    return (
      <div className="jp-xtralab-StatusBar-Terminal-Container">
        <button
          type="button"
          className="jp-xtralab-StatusBar-Terminal-Activate"
          onClick={() => this._onActivate(this._sessionName)}
          aria-label={tooltip}
        >
          <terminalIcon.react
            tag="span"
            verticalAlign="middle"
            stylesheet="statusBar"
          />
          <span className="jp-xtralab-StatusBar-Terminal-Label">{label}</span>
        </button>
        <button
          type="button"
          className="jp-xtralab-StatusBar-Terminal-Close"
          onClick={event => {
            event.stopPropagation();
            this._onShutdown(this._sessionName);
          }}
          title={trans.__('Shut down %1', label)}
          aria-label={trans.__('Shut down %1', label)}
        >
          <closeIcon.react
            tag="span"
            verticalAlign="middle"
            stylesheet="statusBar"
          />
        </button>
      </div>
    );
  }

  private _sessionName: string;
  private _trans: TranslationBundle;
  private _onActivate: (sessionName: string) => void;
  private _onShutdown: (sessionName: string) => void;
}

export namespace TerminalSessionItem {
  export interface IOptions {
    registry: SessionRegistry;
    sessionName: string;
    trans?: TranslationBundle;
    onActivate: (sessionName: string) => void;
    onShutdown: (sessionName: string) => void;
  }
}
