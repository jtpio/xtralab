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
 * The widget shape every entry in `ITerminalTracker` takes.
 */
export type TerminalWidget = MainAreaWidget<ITerminal.ITerminal>;

/**
 * Slice of xterm.js reached through the terminal widget's private `_term`
 * field, so the buffer is readable without depending on `@xterm/xterm`.
 * If upstream renames the field, the activity line is simply omitted.
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
 * How often to ask the server which agent (if any) runs in each terminal.
 */
const DETECT_POLL_INTERVAL_MS = 3000;

/**
 * Backoff cap when detection fails repeatedly (e.g. the endpoint is missing
 * on an older server).
 */
const DETECT_POLL_MAX_MS = 300_000;

/**
 * Window during which a fresh launch tag outranks a `null` detection result:
 * covers the gap between launching an agent and its process becoming visible.
 */
const LAUNCH_GRACE_MS = 4000;

/**
 * How often to re-read each open agent terminal's buffer for the activity line.
 */
const ACTIVITY_POLL_INTERVAL_MS = 1500;

/**
 * Source-of-truth model for the running-terminals panel: live sessions,
 * labels cached across tab closes, agent badges (launch tags reconciled with
 * polled detection, see {@link agentCommandFor}), and per-row latest-activity
 * lines. `stateChanged` fires on every kind of update.
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

    // currentChanged is optional on the shell interface; without it the
    // highlight stays off.
    this._shell?.currentChanged?.connect(this._onShellCurrentChanged, this);
    this._updateCurrent();

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

    // Separate from the detection poll so reading xterm buffers neither
    // delays nor is delayed by the server round-trip.
    this._activityPoll = new Poll({
      name: '@xtralab/terminals:activity',
      factory: () => this._refreshActivity(),
      frequency: { interval: ACTIVITY_POLL_INTERVAL_MS, backoff: false },
      standby: 'when-hidden'
    });
  }

  /**
   * Emitted on any change to the session list, labels, badges, or activity.
   */
  get stateChanged(): ISignal<this, void> {
    return this._stateChanged;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Names of all live sessions in stable (roughly creation) order.
   */
  sessionNames(): string[] {
    const names = Array.from(this._live);
    names.sort((a, b) => this.rankFor(a) - this.rankFor(b));
    return names;
  }

  /**
   * True iff the named session is still on the server.
   */
  has(name: string): boolean {
    return this._live.has(name);
  }

  /**
   * Display name for the session. The cache wins — it holds only "real"
   * labels (see `_cacheLabel`), so the transient `Terminal {name}` an xterm
   * widget shows during reconnect never flickers into the panel; the final
   * fallback covers sessions never seen with a widget (e.g. a lab reload).
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
   * Agent identifier for the session (configured command or canonical id), or
   * `null`. Detection wins when it reports an agent; a launch tag fills the
   * grace window and detection outages, and is ignored once detection says
   * idle — that is how the badge clears when an agent exits.
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
   * The agent command detection currently confirms for the session, or
   * `null`. Never falls back to launch tags: callers about to *write into* a
   * session use it, and text pasted into a shell prompt would be executed.
   */
  detectedCommandFor(name: string): string | null {
    const detected = this._detected.get(name);
    return typeof detected === 'string' ? detected : null;
  }

  /**
   * The most recent meaningful line of the session's output, or `null` when
   * nothing qualifies (no running agent, closed tab, chrome-only buffer, or
   * the activity line is disabled).
   */
  activityFor(name: string): string | null {
    if (!this._activityEnabled) {
      return null;
    }
    return this._activity.get(name) ?? null;
  }

  /**
   * Turn the per-row activity line on or off (the `showAgentActivity`
   * setting). Off drops cached lines; on repopulates them on the spot.
   */
  setActivityEnabled(enabled: boolean): void {
    if (enabled === this._activityEnabled) {
      return;
    }
    this._activityEnabled = enabled;
    if (enabled) {
      // Repopulate immediately rather than waiting for the next poll tick.
      void this._refreshActivity();
    } else {
      this._activity.clear();
      this._stateChanged.emit();
    }
  }

  /**
   * The open widget for a session, if any.
   */
  widgetFor(name: string): TerminalWidget | null {
    return (
      this._tracker.find(widget => widget.content.session.name === name) ?? null
    );
  }

  /**
   * Session name of the terminal that is the shell's current main-area
   * widget, or `null` when the current widget is not a terminal.
   */
  currentSessionName(): string | null {
    return this._currentName;
  }

  /**
   * Stable per-session rank in observation order, so rows don't reshuffle as
   * sessions come and go.
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
   * Adopt `next` as the live set and prune every per-session map, so the
   * maps and rank counter don't grow without bound.
   */
  private _reconcileLive(next: Set<string>): void {
    // The tag map is not enumerable, so the tag prune below is driven from
    // `_firstSeen`, which has an entry for every session ever live.
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
    // terminado reuses session names, so a stale tag could mislabel a
    // brand-new terminal that reuses a closed session's name.
    for (const name of known) {
      if (!next.has(name)) {
        this._agentSessions?.delete(name);
      }
    }
  }

  /**
   * Poll body: update the detection map from the server. On failure the
   * previous results are kept, so a transient error doesn't strip every badge.
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
   * Poll body: cache the latest meaningful output line of each open agent
   * terminal (closed tabs have no live buffer; editors and shells don't
   * qualify). Emits only when something changed.
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
        // The tab is reopening; keep any existing line until its xterm buffer
        // is readable again.
        continue;
      }
      const line = Private.readActivity(term);
      if (line) {
        if (this._activity.get(name) !== line) {
          this._activity.set(name, line);
          changed = true;
        }
      } else if (this._activity.delete(name)) {
        // Readable buffer with nothing to surface (e.g. a cleared screen) —
        // drop the stale line instead of freezing it.
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
    // Re-emit once the grace window closes so a tag detection never confirmed
    // (or has since contradicted) stops being shown.
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
   * Recompute which terminal (if any) is the active main-area widget; emits
   * only on change. Anything not a tracked terminal clears the highlight.
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
   * Cache a label only when it is "real" — not `'...'` or `Terminal {name}`,
   * the transient defaults xterm cycles through during reconnect. Without the
   * filter, reopening a tab before the agent re-emits its title escape would
   * clobber the cached agent name.
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
    // The session may still be running on the server; the cached label stays
    // until `runningChanged` purges it with the session itself.
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
     * Used to highlight the row of the current main-area terminal. Optional:
     * without it (or its `currentChanged`) the highlight stays off.
     */
    shell?: JupyterFrontEnd.IShell | null;
    /**
     * Shared launch-tag registry. When present, its records seed each row's
     * agent badge until server-side detection takes over.
     */
    agentSessions?: IAgentSessions | null;
    /**
     * Names to detect: each agent's command plus its canonical id, so an
     * aliased command (e.g. `ccm` running `claude`) is still matched by the
     * process it spawns. Read on every poll.
     */
    detectCommands?: () => string[];
    /**
     * Whether a detected command (or id) belongs to a coding agent rather
     * than an editor; only agent sessions get a latest-activity line.
     * Defaults to treating every detected command as an agent.
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

  /**
   * Rows above the cursor to scan when looking for the latest output.
   */
  const ACTIVITY_SCAN_ROWS = 64;

  /**
   * Clamp for the activity string so one runaway block can't bloat a row.
   */
  const ACTIVITY_MAX_LENGTH = 160;

  /**
   * Horizontal rule characters treated as blanks when sanitizing (status-line
   * padding is chrome, not text). Vertical bars are excluded on purpose —
   * {@link isMeaningfulActivity} uses them to skip input/quote boxes.
   */
  const RULE_CHARS = new Set([
    0x2500, 0x2501, 0x2504, 0x2505, 0x2508, 0x2509, 0x254c, 0x254d, 0x2550
  ]);

  /**
   * The most recent meaningful line of agent output, or `null`. Agents park
   * the cursor in a bottom input box, so the scan walks *up* past chrome to
   * the nearest output block, then rewinds to that block's first row so a
   * hard-wrapped reply reads as its opening sentence, not a trailing fragment.
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
      // `row` is the block's bottom; walk up to its first row.
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

  /**
   * Sanitized text of one buffer row.
   */
  export function lineText(buffer: IXtermBuffer, row: number): string {
    return sanitizeActivity(buffer.getLine(row)?.translateToString(true) ?? '');
  }

  /**
   * Stitch rows `[topRow, lastRow]` of one output block into a single string.
   * A soft-wrapped row continues mid-word (appended directly); a hard newline
   * is a word boundary (joined with a space).
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

  /**
   * Truncate by code point (never splitting an emoji) with an ellipsis.
   */
  export function clampActivity(text: string): string {
    const points = Array.from(text);
    return points.length > ACTIVITY_MAX_LENGTH
      ? `${points.slice(0, ACTIVITY_MAX_LENGTH - 1).join('')}…`
      : text;
  }

  /**
   * Collapse a raw buffer row into displayable text: control and rule
   * characters become spaces, whitespace runs are squeezed, ends trimmed.
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
   * Whether a sanitized row is real output rather than chrome; doubles as
   * {@link readActivity}'s block-boundary test. Skips rows without a letter
   * or digit, rows starting with a box bar / prompt chevron / `⎿`, and
   * elapsed-time status footers ("✻ Churned for 17s", "Working… (8s · …)").
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
