import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { MainAreaWidget } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITerminal, ITerminalTracker } from '@jupyterlab/terminal';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

const PLUGIN_ID = 'xtralab:terminal-notifications';

/**
 * Minimum gap between two notifications from the same terminal. Coding agents
 * that use the "iterm2 with bell" channel emit an OSC 9 sequence *and* ring the
 * bell back-to-back; collapsing both into one notification is the main reason
 * for the throttle, which also keeps a chatty program from flooding the OS.
 */
const NOTIFY_THROTTLE_MS = 3000;

/**
 * iTerm2 "growl" notification: `ESC ] 9 ; <message> BEL`. The whole payload is
 * the notification text. This is what Claude Code (and most agents) emit on
 * their default `auto` setting once the terminal advertises `TERM_PROGRAM`.
 */
const OSC_ITERM2_GROWL = 9;

/**
 * rxvt/Ghostty notification: `ESC ] 777 ; notify ; <title> ; <body> BEL`. The
 * payload carries an explicit title and body.
 */
const OSC_RXVT_NOTIFY = 777;

/** Longest title/body kept; the main process clamps again before delivery. */
const MAX_TEXT_LENGTH = 256;

/**
 * The bits of an xterm.js `Terminal` this plugin reaches into. The JupyterLab
 * terminal widget keeps its xterm instance in a private field (see below), and
 * xterm's notification hooks are not surfaced on JupyterLab's `ITerminal`
 * interface, so a structural type keeps the access honest without depending on
 * `@xterm/xterm` directly.
 */
interface IXtermDisposable {
  dispose(): void;
}
interface IXtermTerminal {
  onBell(handler: () => void): IXtermDisposable;
  parser: {
    registerOscHandler(
      ident: number,
      callback: (data: string) => boolean
    ): IXtermDisposable;
  };
}

/**
 * The JupyterLab terminal widget's content exposes a `ready` promise (resolved
 * once the xterm instance exists) and stores that instance in the private
 * `_term` field. xterm's field name has been stable for years; if it ever
 * changes, `_term` is simply `undefined` and notifications quietly turn off.
 */
interface ITerminalContentInternals extends ITerminal.ITerminal {
  ready: Promise<void>;
  _term?: IXtermTerminal;
}

type TerminalWidget = MainAreaWidget<ITerminal.ITerminal>;

/**
 * The renderer→main bridge the desktop shell injects on the lab window
 * (`desktop/src/preload-lab.ts`). Absent for plain `pip install` users running
 * in a browser, who fall back to the Web Notifications API.
 */
interface IDesktopBridge {
  notify?: (
    title: string,
    body: string,
    session?: string
  ) => Promise<void> | void;
  onFocusTerminal?: (callback: (session: string) => void) => void;
}

/**
 * Turns the notifications coding agents already emit (Claude Code, Codex, …)
 * into real desktop notifications.
 *
 * Terminals like iTerm2 and Ghostty show a system notification when a program
 * asks for one — via an OSC escape sequence or the bell — and agents use that
 * on their default `auto` setting to tell you they finished or need input.
 * JupyterLab's xterm renders the sequences but never forwards them to the OS,
 * so this plugin hooks each terminal's xterm and bridges them:
 *
 *   - OSC 9  (`ESC ] 9 ; msg BEL`)            — iTerm2 growl
 *   - OSC 777 (`ESC ] 777 ; notify ; t ; b`)  — rxvt/Ghostty
 *   - the bell                                — the universal fallback
 *
 * Delivery goes through the desktop shell's `window.xtralab.notify` bridge —
 * the main process posts a native notification (signed builds) or falls back to
 * `osascript` (unsigned dev builds) — or the Web Notifications API in a plain
 * browser. The terminal's session name is forwarded so that clicking a native
 * notification focuses the exact terminal that fired it (see `onFocusTerminal`).
 *
 * A notification is suppressed while its terminal is the focused, active tab —
 * if you are already looking at it, the banner is noise — and throttled per
 * terminal so the "OSC 9 plus a bell" combo agents emit becomes one banner.
 *
 * The desktop shell also advertises `TERM_PROGRAM=iTerm.app` to the terminal so
 * agents take their iTerm2 notification path; without a recognized
 * `TERM_PROGRAM` their `auto` setting emits nothing at all.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Forwards desktop notifications emitted by agents in xtralab terminals (OSC 9, OSC 777, bell) to the operating system.',
  autoStart: true,
  requires: [ITerminalTracker],
  optional: [ISettingRegistry, ITranslator],
  activate: async (
    app: JupyterFrontEnd,
    tracker: ITerminalTracker,
    settingRegistry: ISettingRegistry | null,
    translator: ITranslator | null
  ): Promise<void> => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    let enabled = true;
    let notifyOnBell = true;

    // Last time we notified for a given terminal, used by the throttle. A
    // WeakMap lets disposed widgets (and their timestamps) be collected.
    const lastNotified = new WeakMap<TerminalWidget, number>();
    // The xterm hooks registered per widget, torn down when the tab closes.
    const hooks = new WeakMap<TerminalWidget, IXtermDisposable[]>();

    /**
     * Whether the user is already looking at this terminal: the window has
     * focus and the terminal is the active main-area tab. In that case its
     * output is visible, so a banner would only be noise.
     */
    const isActivelyViewing = (widget: TerminalWidget): boolean =>
      document.hasFocus() && app.shell.currentWidget === widget;

    const deliver = (title: string, body: string, session?: string): void => {
      const bridge = (window as Window & { xtralab?: IDesktopBridge }).xtralab;
      if (bridge && typeof bridge.notify === 'function') {
        void Promise.resolve(bridge.notify(title, body, session)).catch(
          reason => {
            console.warn('xtralab: desktop notification failed', reason);
          }
        );
        return;
      }

      // Plain-browser fallback (pip install): the Web Notifications API. The
      // desktop lab window blocks web notifications by policy and uses the
      // bridge above instead, so this path only runs outside Electron.
      if (typeof Notification === 'undefined') {
        return;
      }
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission !== 'denied') {
        void Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            new Notification(title, { body });
          }
        });
      }
    };

    const notify = (
      widget: TerminalWidget,
      title: string,
      body: string
    ): void => {
      if (!enabled || isActivelyViewing(widget)) {
        return;
      }
      const now = Date.now();
      const previous = lastNotified.get(widget);
      if (previous !== undefined && now - previous < NOTIFY_THROTTLE_MS) {
        return;
      }
      lastNotified.set(widget, now);
      // The session name lets the desktop shell focus this exact terminal when
      // its notification is clicked (see the onFocusTerminal wiring below).
      const session = widget.content.session?.name;
      deliver(sanitize(title) || 'xtralab', sanitize(body), session);
    };

    // The terminal's tab label is the agent's name (Claude, Codex, …) once the
    // launcher or an xterm title sequence sets it, so it reads well as the
    // notification title for sequences that carry only a body (OSC 9, bell).
    const labelOf = (widget: TerminalWidget): string =>
      widget.title.label || trans.__('Terminal');

    const onOsc9 = (widget: TerminalWidget, data: string): boolean => {
      // OSC 9 is overloaded: iTerm2 uses `9 ; <message>` for a notification,
      // while ConEmu/Windows Terminal use `9 ; <n> ; …` subcommands — most
      // notably `9 ; 4` progress reports. Ignore anything that opens with a
      // numeric subcommand so a progress bar can't masquerade as a
      // notification, and leave it unconsumed for any progress handler.
      if (/^\d(;|$)/.test(data)) {
        return false;
      }
      const message = sanitize(data);
      if (message) {
        notify(widget, labelOf(widget), message);
      }
      // OSC 9 is iTerm2's notification namespace; consume it.
      return true;
    };

    const onOsc777 = (widget: TerminalWidget, data: string): boolean => {
      // `notify ; <title> ; <body>` — a body may itself contain ';', so only
      // the first two separators are structural. Anything that is not a
      // `notify` command (other rxvt/tmux OSC 777 extensions) is left for any
      // other handler by reporting the sequence as not consumed.
      const parts = data.split(';');
      if (parts.shift() !== 'notify') {
        return false;
      }
      const title = sanitize(parts.shift() ?? '') || labelOf(widget);
      const body = sanitize(parts.join(';'));
      if (body || title) {
        notify(widget, title, body);
      }
      return true;
    };

    const onBell = (widget: TerminalWidget): void => {
      if (notifyOnBell) {
        notify(widget, labelOf(widget), trans.__('Activity in terminal'));
      }
    };

    const hookWidget = (widget: TerminalWidget): void => {
      if (hooks.has(widget)) {
        return;
      }
      const content = widget.content as ITerminalContentInternals;
      void content.ready
        .then(() => {
          const term = content._term;
          if (widget.isDisposed || !term) {
            return;
          }
          // An OSC handler returns `true` to mark the sequence consumed. Each
          // is wrapped so a parse slip can never break the terminal's parser
          // (and a thrown handler reports "not consumed").
          const disposables: IXtermDisposable[] = [
            term.onBell(() => guard(() => onBell(widget))),
            term.parser.registerOscHandler(OSC_ITERM2_GROWL, data =>
              guardOsc(() => onOsc9(widget, data))
            ),
            term.parser.registerOscHandler(OSC_RXVT_NOTIFY, data =>
              guardOsc(() => onOsc777(widget, data))
            )
          ];
          hooks.set(widget, disposables);
          widget.disposed.connect(() => {
            for (const disposable of disposables) {
              disposable.dispose();
            }
            hooks.delete(widget);
          });
        })
        .catch(reason => {
          console.warn(
            'xtralab: could not hook terminal notifications',
            reason
          );
        });
    };

    tracker.forEach(hookWidget);
    tracker.widgetAdded.connect((_, widget) => hookWidget(widget));

    // When the desktop shell reports that a (native) notification was clicked,
    // activate the terminal that fired it. `terminal:open` focuses the existing
    // tab, or reopens the session if its tab was closed — the same entry point
    // the running-terminals panel uses. Absent outside the desktop shell.
    const desktopBridge = (window as Window & { xtralab?: IDesktopBridge })
      .xtralab;
    desktopBridge?.onFocusTerminal?.(session => {
      if (session) {
        void app.commands.execute('terminal:open', { name: session });
      }
    });

    if (settingRegistry) {
      try {
        const settings = await settingRegistry.load(PLUGIN_ID);
        const readSettings = (): void => {
          enabled = boolOption(settings.composite.enabled, true);
          notifyOnBell = boolOption(settings.composite.notifyOnBell, true);
        };
        readSettings();
        settings.changed.connect(readSettings);
      } catch (reason) {
        console.error(
          'xtralab: failed to load terminal-notifications settings',
          reason
        );
      }
    }
  }
};

/**
 * Run `fn`, swallowing any error so a malformed escape sequence can never take
 * the terminal's parser or bell handler down with it.
 */
function guard(fn: () => void): void {
  try {
    fn();
  } catch (reason) {
    console.warn('xtralab: terminal notification handler failed', reason);
  }
}

/**
 * Like {@link guard}, for an OSC handler that returns whether it consumed the
 * sequence. A thrown handler reports "not consumed" so xterm can fall through.
 */
function guardOsc(fn: () => boolean): boolean {
  try {
    return fn();
  } catch (reason) {
    console.warn('xtralab: terminal notification handler failed', reason);
    return false;
  }
}

/**
 * Replace control characters with spaces (so a notification can't smuggle
 * escape sequences), collapse whitespace, and clamp the length.
 */
function sanitize(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    result += isControl ? ' ' : char;
  }
  return result.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
}

function boolOption(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export default plugin;
