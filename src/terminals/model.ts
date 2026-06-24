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
 * The slice of an xterm.js `Terminal` the registry reads to surface a
 * session's most recent line of output. JupyterLab keeps its xterm in the
 * terminal widget's private `_term` field, so a structural type reaches the
 * buffer without taking a dependency on `@xterm/xterm` — the same access the
 * terminal-notifications plugin already relies on. If the field is ever
 * renamed, `_term` reads back `undefined` and the activity line is simply
 * omitted: the row falls back to its title alone.
 */
interface IXtermBufferLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}
interface IXtermBuffer {
  readonly baseY: number;
  readonly cursorY: number;
  getLine(index: number): IXtermBufferLine | undefined;
}
interface IXtermTerminal {
  readonly buffer: { readonly active: IXtermBuffer };
}
interface ITerminalContentInternals extends ITerminal.ITerminal {
  _term?: IXtermTerminal;
}

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
 * How often to re-read each open coding-agent terminal's output buffer to
 * refresh the "latest activity" line shown under its row. Brisk enough to feel
 * live while an agent works, cheap because it only walks the last screenful of
 * a handful of terminals and emits only when a line actually changes.
 */
const ACTIVITY_POLL_INTERVAL_MS = 1500;

/**
 * Source-of-truth model for the running-terminals panel. Each running
 * terminal session known to the server is one entry; the registry caches
 * the last `widget.title.label` we observed so the agent name (or any
 * xterm-published title) survives the user closing the tab while the
 * session continues running on the backend.
 *
 * For sessions running a coding agent it also surfaces a *latest activity*
 * line — the freshest meaningful line of the terminal's output, read from the
 * open tab's xterm buffer on a poll (see {@link activityFor}) — so each row
 * shows what its agent is doing, not just its name.
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
    this._isAgentCommand = options.isAgentCommand ?? (() => true);
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

    // A second, faster poll reads the live output buffer of each open
    // coding-agent terminal to keep its "latest activity" line current. Kept
    // separate from the detection poll so reading xterm buffers neither delays
    // nor is delayed by the server round-trip that drives the agent badges.
    this._activityPoll = new Poll({
      name: '@xtralab/terminals:activity',
      factory: () => this._refreshActivity(),
      frequency: { interval: ACTIVITY_POLL_INTERVAL_MS, backoff: false },
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
   * An identifier for the agent running in the session — its configured
   * command, or its canonical id when detection matched the spawned process by
   * id rather than by an aliased command — or `null` if none. Callers resolve
   * it to a logo through the plugin's `iconForCommand`, which accepts either.
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
   * The most recent meaningful line of output from the session's terminal, or
   * `null` when there is nothing to surface — no coding agent is running in the
   * session, its tab is closed (so there is no live buffer to read), or the
   * buffer holds only the agent's input box and chrome. Refreshed on a poll by
   * {@link _refreshActivity}; shown as a smaller line under the row's title.
   * Always `null` while the activity line is disabled (see
   * {@link setActivityEnabled}).
   */
  activityFor(name: string): string | null {
    if (!this._activityEnabled) {
      return null;
    }
    return this._activity.get(name) ?? null;
  }

  /**
   * Turn the per-row latest-activity line on or off, driven by the
   * `xtralab:terminals` `showAgentActivity` setting. When turned off the
   * activity poll stops reading terminal buffers and any cached lines are
   * dropped, so rows fall back to their title alone; when turned back on the
   * lines are repopulated on the spot. A no-op when the value is unchanged.
   */
  setActivityEnabled(enabled: boolean): void {
    if (enabled === this._activityEnabled) {
      return;
    }
    this._activityEnabled = enabled;
    if (enabled) {
      // Repopulate immediately rather than waiting for the next poll tick;
      // `_refreshActivity` emits `stateChanged` if it finds anything to show.
      void this._refreshActivity();
    } else {
      this._activity.clear();
      this._stateChanged.emit();
    }
  }

  /**
   * Return the open widget for a session, if any. The panel uses this to
   * switch behavior between "activate existing tab" and "open a new tab
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
    this._activityPoll.dispose();
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
    for (const name of Array.from(this._activity.keys())) {
      if (!next.has(name)) {
        this._activity.delete(name);
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

  /**
   * Poll body: re-read the buffer of each open coding-agent terminal and cache
   * its latest meaningful line of output. Only sessions that have a running
   * *agent* (not an editor) and an open tab qualify — a closed tab has no live
   * buffer, editors run full-screen UIs that are not "activity", and plain
   * shells would only echo their prompt. While a tab is reopening (its xterm
   * is not ready yet) any existing line is kept; once the buffer is readable
   * but has nothing worth showing the line is dropped, so a screen the agent
   * has cleared doesn't leave a frozen line behind. Cached lines for sessions
   * that no longer qualify are pruned. Emits only when something changed.
   */
  private async _refreshActivity(): Promise<void> {
    if (!this._activityEnabled) {
      return;
    }
    let changed = false;
    const qualifying = new Set<string>();
    for (const name of this._live) {
      const command = this.agentCommandFor(name);
      if (command === null || !this._isAgentCommand(command)) {
        continue;
      }
      const widget = this.widgetFor(name);
      if (!widget) {
        continue;
      }
      qualifying.add(name);
      const term = (widget.content as ITerminalContentInternals)._term;
      if (!term) {
        // The tab is reopening and its xterm is not ready; keep any existing
        // line until the buffer can be read again.
        continue;
      }
      const line = Private.readActivity(term);
      if (line) {
        if (this._activity.get(name) !== line) {
          this._activity.set(name, line);
          changed = true;
        }
      } else if (this._activity.delete(name)) {
        // Readable buffer with nothing to surface (e.g. the agent cleared its
        // screen) — drop the now-stale line instead of freezing it.
        changed = true;
      }
    }
    for (const name of Array.from(this._activity.keys())) {
      if (!qualifying.has(name)) {
        this._activity.delete(name);
        changed = true;
      }
    }
    if (changed) {
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
    const session = owner.content.session;
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
   * `Terminal 1`. Live widget titles still display whatever the widget
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
  private _isAgentCommand: (command: string) => boolean;
  private _shell: JupyterFrontEnd.IShell | null;
  private _poll: Poll;
  private _activityPoll: Poll;
  private _labels = new Map<string, string>();
  private _ranks = new Map<string, number>();
  private _firstSeen = new Map<string, number>();
  private _detected = new Map<string, string | null>();
  private _activity = new Map<string, string>();
  private _activityEnabled = true;
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
     * Returns the names the server should look for when detecting running
     * agents — each agent's command together with its canonical id, so a
     * command pointed at an alias (e.g. `ccm` running `claude`) is still
     * matched by the process it spawns. Read on every poll so it tracks the
     * live agent list.
     */
    detectCommands?: () => string[];
    /**
     * Whether a detected command (or id) belongs to a coding agent rather than
     * an editor. Only agent sessions get a latest-activity line — editors
     * (Neovim/Vim) are badged too, but run full-screen UIs whose buffer is not
     * meaningfully "activity". Defaults to treating every detected command as an
     * agent.
     */
    isAgentCommand?: (command: string) => boolean;
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

  /** Rows above the cursor to scan when looking for the latest output. */
  const ACTIVITY_SCAN_ROWS = 64;

  /** Clamp for the activity string so one runaway block can't bloat a row. */
  const ACTIVITY_MAX_LENGTH = 160;

  /**
   * Horizontal box-drawing / rule characters, treated as blanks when
   * sanitizing. Agents pad a status line or draw a separator with these (e.g.
   * `Worked for 1m 06s ────`), which is chrome, not text. Vertical bars are
   * deliberately excluded — {@link isMeaningfulActivity} relies on them to
   * recognise (and skip) the contents of an input/quote box.
   */
  const RULE_CHARS = new Set([
    0x2500, 0x2501, 0x2504, 0x2505, 0x2508, 0x2509, 0x254c, 0x254d, 0x2550
  ]);

  /**
   * The most recent meaningful line of agent output, or `null` if none is
   * found. Agents park the cursor in an input box at the bottom of the screen,
   * so the scan starts there and walks *up*, skipping that box, any hint or
   * footer beneath it, blank lines and separators, until it reaches the block
   * of real output nearest the input. It then rewinds to that block's first row
   * and stitches the block back together (see {@link joinBlock}), so a reply
   * the agent hard-wrapped across several rows reads as its opening sentence
   * rather than the trailing fragment left next to the cursor.
   */
  export function readActivity(term: IXtermTerminal): string | null {
    const buffer = term.buffer?.active;
    if (!buffer) {
      return null;
    }
    const cursorRow = buffer.baseY + buffer.cursorY;
    const limit = Math.max(0, cursorRow - ACTIVITY_SCAN_ROWS);
    for (let row = cursorRow; row >= limit; row--) {
      if (!isMeaningfulActivity(lineText(buffer, row))) {
        continue;
      }
      // `row` is the bottom of the output block nearest the input; walk up
      // while rows stay meaningful to find the block's first row.
      let topRow = row;
      while (
        topRow > limit &&
        isMeaningfulActivity(lineText(buffer, topRow - 1))
      ) {
        topRow--;
      }
      return clampActivity(joinBlock(buffer, topRow, row));
    }
    return null;
  }

  /** Sanitized text of one buffer row. */
  export function lineText(buffer: IXtermBuffer, row: number): string {
    return sanitizeActivity(buffer.getLine(row)?.translateToString(true) ?? '');
  }

  /**
   * Stitch rows `[topRow, lastRow]` of one output block into a single string,
   * stopping once it is long enough to fill the row. A soft-wrapped row
   * continues the previous one mid-word, so it is appended directly; a hard
   * newline is a word boundary, so it is joined with a space.
   */
  export function joinBlock(
    buffer: IXtermBuffer,
    topRow: number,
    lastRow: number
  ): string {
    let result = lineText(buffer, topRow);
    for (let row = topRow + 1; row <= lastRow; row++) {
      if (Array.from(result).length >= ACTIVITY_MAX_LENGTH) {
        break;
      }
      const bufferLine = buffer.getLine(row);
      const text = sanitizeActivity(bufferLine?.translateToString(true) ?? '');
      if (!text) {
        continue;
      }
      result += bufferLine?.isWrapped ? text : ` ${text}`;
    }
    return result;
  }

  /** Truncate by code point (never splitting an emoji) with an ellipsis. */
  export function clampActivity(text: string): string {
    const points = Array.from(text);
    return points.length > ACTIVITY_MAX_LENGTH
      ? `${points.slice(0, ACTIVITY_MAX_LENGTH - 1).join('')}…`
      : text;
  }

  /**
   * Collapse a raw buffer row into displayable text: replace control characters
   * and horizontal rule characters with spaces (so no escape sequence or drawn
   * separator rides along), squeeze runs of whitespace, and trim.
   */
  export function sanitizeActivity(value: string): string {
    let result = '';
    for (const char of value) {
      const code = char.codePointAt(0) ?? 0;
      const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
      result += isControl || RULE_CHARS.has(code) ? ' ' : char;
    }
    return result.replace(/\s+/g, ' ').trim();
  }

  /**
   * Whether a sanitized row is worth showing as activity, i.e. real output
   * rather than chrome. Doubles as the block-boundary test for
   * {@link readActivity}'s walk up. A row is skipped when it:
   *   - is blank or pure box-drawing (carries no letter or digit);
   *   - begins with a vertical box-drawing bar (the contents of an input or
   *     quote box), a prompt chevron (the input row and its ghost suggestion),
   *     or Claude's tool-result / tip marker `⎿`; or
   *   - is a transient status footer — one carrying a `for <time>` / `(<time>`
   *     elapsed-time stamp, as agents print while and after they work
   *     ("✻ Churned for 17s", "Working… (8s · …)", "— Worked for 1m 06s"). This
   *     carries no real content, so skipping it lets the scan reach the reply
   *     the agent wrote just above it.
   */
  export function isMeaningfulActivity(text: string): boolean {
    if (!text) {
      return false;
    }
    if (/^[│┃║❯❮›‹⎿]/u.test(text)) {
      return false;
    }
    if (/(?:for |\()\d+(?:\s?m\s?\d+)?s\b/u.test(text)) {
      return false;
    }
    return /[\p{L}\p{N}]/u.test(text);
  }
}
