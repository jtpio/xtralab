import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { MainAreaWidget } from '@jupyterlab/apputils';
import type { ServiceManager, Terminal } from '@jupyterlab/services';
import type { ITerminal, ITerminalTracker } from '@jupyterlab/terminal';
import type { IDisposable } from '@lumino/disposable';
import { Poll } from '@lumino/polling';
import { ISignal, Signal } from '@lumino/signaling';
import type { Title, Widget } from '@lumino/widgets';

import type { IAgentSessions } from '../agentSessions';
import { fetchRunningAgents } from './detection';

/**
 * The widget shape every entry in `ITerminalTracker` takes — kept here
 * so the registry's call sites read cleanly.
 */
export type TerminalWidget = MainAreaWidget<ITerminal.ITerminal>;

/**
 * How often to ask the server which agent (if any) is running in each
 * terminal. Snappy enough that a manually-started agent's logo shows up
 * within a few seconds, light enough that walking the shells' process trees
 * stays negligible.
 */
const DETECT_POLL_INTERVAL_MS = 3000;

/**
 * Upper bound on the exponential backoff when detection fails repeatedly
 * (e.g. the endpoint is missing on an older server). Matches the rest of the
 * plugin's polls.
 */
const DETECT_POLL_MAX_MS = 300_000;

/**
 * Grace window after a session first appears during which an optimistic
 * launch tag outranks a `null` detection result. It covers the gap between
 * issuing an agent's command and its process actually being spawnable, so the
 * freshly-launched logo doesn't blink off if a detection poll lands in that
 * sliver. Comfortably longer than a cold agent start; short enough that a tag
 * for an agent that never really started clears quickly.
 */
const LAUNCH_GRACE_MS = 4000;

/**
 * Source-of-truth model for the running-terminals panel. Each running
 * terminal session known to the server is one entry; the registry caches
 * the last `widget.title.label` we observed so the agent name (or any
 * xterm-published title) survives the user closing the tab while the
 * session continues running on the backend.
 *
 * It also resolves *which agent is running* in each session, so the panel can
 * badge rows with the agent's logo. Two inputs feed that, reconciled by
 * {@link agentCommandFor}:
 *   - an optimistic launch tag ({@link IAgentSessions}) written when we start
 *     an agent ourselves — instant, but blind to the agent later exiting; and
 *   - authoritative server-side process detection, polled here, which works
 *     for hand-started agents too and clears once an agent exits.
 *
 * Upstream session signals:
 *   - `serviceManager.terminals.runningChanged` is the authoritative
 *     list of live sessions; everything not in it has been shut down
 *     server-side and we must drop it.
 *   - `tracker.widgetAdded` plus the per-widget `title.changed` /
 *     `disposed` signals keep our label cache in sync with whatever
 *     xterm/the launcher has set on the open tabs.
 *
 * `stateChanged` is emitted for every kind of update; the panel hooks it
 * through a `UseSignal` so a single subscription re-renders the list on
 * any change.
 */
export class SessionRegistry implements IDisposable {
  constructor(options: SessionRegistry.IOptions) {
    this._terminals = options.serviceManager.terminals;
    this._tracker = options.tracker;
    this._agentSessions = options.agentSessions ?? null;
    this._detectCommands = options.detectCommands ?? (() => []);
    this._shell = options.shell ?? null;

    this._terminals.runningChanged.connect(this._onRunningChanged, this);
    this._tracker.widgetAdded.connect(this._onWidgetAdded, this);
    this._tracker.forEach(widget => this._trackWidget(widget));
    this._refreshLive();

    // Track which terminal is the current widget in the main area so the panel
    // can highlight its row — and highlight nothing while a notebook or any
    // other non-terminal tab is current instead. `currentChanged` is optional
    // on the shell interface (not every shell can switch focus), so guard it;
    // when it is absent the highlight stays off.
    this._shell?.currentChanged?.connect(this._onShellCurrentChanged, this);
    this._updateCurrent();

    // A freshly written launch tag should re-render the panel immediately
    // (show the logo) and again once the grace window closes (so a tag for
    // an agent that never started, or that detection later contradicts,
    // doesn't linger).
    this._agentSessions?.changed.connect(this._onTagChanged, this);

    this._poll = new Poll({
      name: '@xtralab/terminals:runningAgents',
      factory: () => this._refreshDetection(),
      frequency: {
        interval: DETECT_POLL_INTERVAL_MS,
        backoff: true,
        max: DETECT_POLL_MAX_MS
      },
      standby: 'when-hidden'
    });
  }

  /**
   * Emitted whenever the live session list, a cached label, or the detected
   * running agent changes.
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
   * The command of the agent running in the session, or `null` if none.
   *
   * Server-side detection is authoritative whenever it reports a running
   * agent. A launch tag fills two gaps: the startup grace window right after
   * we launch an agent (so its logo shows before its process is detectable),
   * and any time detection is unavailable (older server, transient error).
   * Once the grace window has passed and detection has reported the session
   * as idle, the tag is ignored — that is how the badge clears when an agent
   * exits.
   */
  agentCommandFor(name: string): string | null {
    // `string` = detected running agent, `null` = polled and idle,
    // `undefined` = not covered by a successful poll yet.
    const detected = this._detected.has(name)
      ? this._detected.get(name)!
      : undefined;
    if (typeof detected === 'string') {
      return detected;
    }
    const tagged = this._agentSessions?.get(name) ?? null;
    if (tagged !== null) {
      const seenAt = this._firstSeen.get(name) ?? 0;
      const inGrace = Date.now() - seenAt < LAUNCH_GRACE_MS;
      if (inGrace || detected === undefined) {
        return tagged;
      }
    }
    return null;
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
   * Session name of the terminal that is currently the active widget in the
   * shell's main area, or `null` when that widget is not a terminal (for
   * example a notebook or text editor is current). The panel uses this to
   * highlight the current terminal's row — mirroring how the file browser
   * surfaces the open document — and to leave every row unhighlighted while a
   * non-terminal tab is current.
   */
  currentSessionName(): string | null {
    return this._currentName;
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
    this._poll.dispose();
    this._terminals.runningChanged.disconnect(this._onRunningChanged, this);
    this._tracker.widgetAdded.disconnect(this._onWidgetAdded, this);
    this._agentSessions?.changed.disconnect(this._onTagChanged, this);
    this._shell?.currentChanged?.disconnect(this._onShellCurrentChanged, this);
    this._tracker.forEach(widget => this._untrackWidget(widget));
    Signal.clearData(this);
  }

  private _refreshLive(): void {
    const next = new Set<string>();
    for (const model of this._terminals.running()) {
      next.add(model.name);
    }
    this._reconcileLive(next);
  }

  private _onRunningChanged(_: unknown, sessions: Terminal.IModel[]): void {
    this._reconcileLive(new Set(sessions.map(model => model.name)));
    this._stateChanged.emit();
  }

  /**
   * Adopt `next` as the live set and prune every per-session map for
   * sessions that have gone away — labels, ranks, first-seen timestamps,
   * detection results, and the shared launch tag. Without this the maps (and
   * the rank counter) would grow without bound as terminals come and go.
   */
  private _reconcileLive(next: Set<string>): void {
    // Names we had already seen, captured before we prune below — the set of
    // candidates whose launch tag may now need forgetting. (The tag map is
    // not enumerable, so we drive the prune from the sessions we know about;
    // `_firstSeen` has an entry for every session that has ever been live.)
    const known = Array.from(this._firstSeen.keys());

    for (const name of next) {
      if (!this._firstSeen.has(name)) {
        this._firstSeen.set(name, Date.now());
      }
    }
    this._live = next;
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
    for (const name of Array.from(this._firstSeen.keys())) {
      if (!next.has(name)) {
        this._firstSeen.delete(name);
      }
    }
    for (const name of Array.from(this._detected.keys())) {
      if (!next.has(name)) {
        this._detected.delete(name);
      }
    }
    // Forget launch tags for sessions that have gone away. This matters for
    // correctness as well as bookkeeping: terminado reuses session names, so
    // a stale tag could otherwise mislabel a brand-new terminal that happens
    // to reuse a closed session's name.
    for (const name of known) {
      if (!next.has(name)) {
        this._agentSessions?.delete(name);
      }
    }
  }

  /**
   * Poll body: ask the server which agent runs in each terminal and update
   * the detection map. On failure we keep the previous results rather than
   * clearing them, so a transient error doesn't strip every badge.
   */
  private async _refreshDetection(): Promise<void> {
    const commands = this._detectCommands();
    if (commands.length === 0) {
      if (this._detected.size > 0) {
        this._detected = new Map();
        this._stateChanged.emit();
      }
      return;
    }
    const result = await fetchRunningAgents(commands);
    if (result === null) {
      return;
    }
    const next = new Map<string, string | null>();
    for (const [name, command] of Object.entries(result)) {
      if (this._live.has(name)) {
        next.set(name, command);
      }
    }
    if (!Private.detectedEqual(this._detected, next)) {
      this._detected = next;
      this._stateChanged.emit();
    }
  }

  private _onTagChanged(): void {
    this._stateChanged.emit();
    // Re-render once the grace window closes so a tag that detection never
    // confirmed (or has since contradicted) stops being shown.
    setTimeout(() => {
      if (!this._isDisposed) {
        this._stateChanged.emit();
      }
    }, LAUNCH_GRACE_MS + 100);
  }

  private _onWidgetAdded(_: unknown, widget: TerminalWidget): void {
    this._trackWidget(widget);
    this._stateChanged.emit();
  }

  private _onShellCurrentChanged(): void {
    this._updateCurrent();
  }

  /**
   * Recompute which terminal (if any) is the active main-area widget and emit
   * only when it changes. The terminal tracker tells us whether the shell's
   * current widget is one of our terminals; anything else — a notebook, an
   * editor, or nothing — clears the highlight.
   */
  private _updateCurrent(): void {
    const current = this._shell?.currentWidget ?? null;
    const name =
      current && this._tracker.has(current)
        ? (current as TerminalWidget).content.session.name
        : null;
    if (name !== this._currentName) {
      this._currentName = name;
      this._stateChanged.emit();
    }
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
  private _agentSessions: IAgentSessions | null;
  private _detectCommands: () => string[];
  private _shell: JupyterFrontEnd.IShell | null;
  private _poll: Poll;
  private _labels = new Map<string, string>();
  private _ranks = new Map<string, number>();
  private _firstSeen = new Map<string, number>();
  private _detected = new Map<string, string | null>();
  private _live = new Set<string>();
  private _currentName: string | null = null;
  private _nextRank = 100;
  private _isDisposed = false;
  private _stateChanged = new Signal<this, void>(this);
}

/**
 * Construction options for {@link SessionRegistry}.
 */
export namespace SessionRegistry {
  export interface IOptions {
    serviceManager: ServiceManager.IManager;
    tracker: ITerminalTracker;
    /**
     * The application shell, used to tell which widget is currently active so
     * the panel can highlight the terminal that is the current main-area
     * widget — and highlight nothing when that widget is not a terminal (a
     * notebook, an editor, …). Optional: without it, or on a shell that cannot
     * report `currentChanged`, the highlight stays off.
     */
    shell?: JupyterFrontEnd.IShell | null;
    /**
     * Shared launch-tag registry. When present, its records seed each row's
     * agent badge until server-side detection takes over.
     */
    agentSessions?: IAgentSessions | null;
    /**
     * Returns the agent commands the server should look for when detecting
     * running agents. Read on every poll so it tracks the live agent list.
     */
    detectCommands?: () => string[];
  }
}

namespace Private {
  /**
   * Value-equality for two detection maps, so a poll that changes nothing
   * doesn't trigger a re-render.
   */
  export function detectedEqual(
    a: Map<string, string | null>,
    b: Map<string, string | null>
  ): boolean {
    if (a.size !== b.size) {
      return false;
    }
    for (const [name, command] of a) {
      if (!b.has(name) || b.get(name) !== command) {
        return false;
      }
    }
    return true;
  }
}
