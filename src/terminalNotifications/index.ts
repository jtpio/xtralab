import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { MainAreaWidget } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITerminal, ITerminalTracker } from '@jupyterlab/terminal';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

const PLUGIN_ID = 'xtralab:terminal-notifications';

// Per-terminal gap between notifications, so the OSC-9-plus-bell agents emit
// together collapses into one and a chatty program cannot flood the OS.
const NOTIFY_THROTTLE_MS = 3000;

// iTerm2 growl notification: `ESC ] 9 ; <message> BEL`. What Claude Code and
// most agents emit on their default `auto` setting once TERM_PROGRAM is set.
const OSC_ITERM2_GROWL = 9;

// rxvt/Ghostty notification: `ESC ] 777 ; notify ; <title> ; <body> BEL`.
const OSC_RXVT_NOTIFY = 777;

const MAX_TEXT_LENGTH = 256;

// The bits of an xterm.js `Terminal` we reach into. JupyterLab's terminal
// widget keeps its xterm in a private `_term` field and does not expose these
// hooks, so a structural type uses them without depending on `@xterm/xterm`. If
// the field is ever renamed, `_term` is `undefined` and notifications stop.
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
interface ITerminalContentInternals extends ITerminal.ITerminal {
  ready: Promise<void>;
  _term?: IXtermTerminal;
}

type TerminalWidget = MainAreaWidget<ITerminal.ITerminal>;

// The renderer→main bridge the desktop shell injects on the lab window. Absent
// for pip-install users in a browser, who fall back to web Notifications.
interface IDesktopBridge {
  notify?: (
    title: string,
    body: string,
    session?: string
  ) => Promise<void> | void;
  onFocusTerminal?: (callback: (session: string) => void) => void;
}

/**
 * Turns the notifications coding agents already emit (OSC 9, OSC 777, the bell)
 * into desktop notifications. JupyterLab's xterm renders these sequences but
 * never forwards them to the OS, so this plugin hooks each terminal and bridges
 * them through `window.xtralab.notify` (desktop) or the web Notifications API.
 *
 * A notification is suppressed while its terminal is the focused, active tab,
 * and throttled per terminal. The desktop shell advertises
 * `TERM_PROGRAM=iTerm.app` so agents emit OSC 9 in the first place, and the
 * session name is forwarded so clicking a notification focuses the terminal
 * that fired it.
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

    // Per-widget throttle timestamps and xterm hooks. WeakMaps let disposed
    // widgets be collected; hooks are torn down when a tab closes.
    const lastNotified = new WeakMap<TerminalWidget, number>();
    const hooks = new WeakMap<TerminalWidget, IXtermDisposable[]>();

    // True when the user is already looking at this terminal, so a banner would
    // just be noise.
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
      // Plain-browser fallback (pip install): the Web Notifications API.
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
      const session = widget.content.session?.name;
      deliver(sanitize(title) || 'xtralab', sanitize(body), session);
    };

    // The tab label is the agent's name once the launcher or an xterm title sets
    // it, so it reads well as the title for body-only sequences (OSC 9, bell).
    const labelOf = (widget: TerminalWidget): string =>
      widget.title.label || trans.__('Terminal');

    const onOsc9 = (widget: TerminalWidget, data: string): boolean => {
      // OSC 9 is overloaded: ConEmu/Windows Terminal use `9 ; <n> ; …`
      // subcommands (e.g. `9 ; 4` progress), so skip a numeric-subcommand
      // payload and leave it unconsumed rather than treat it as a notification.
      if (/^\d(;|$)/.test(data)) {
        return false;
      }
      const message = sanitize(data);
      if (message) {
        notify(widget, labelOf(widget), message);
      }
      return true;
    };

    const onOsc777 = (widget: TerminalWidget, data: string): boolean => {
      // `notify ; <title> ; <body>`; a body may contain ';'. Other OSC 777
      // subcommands are left unconsumed.
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
          // Handlers are wrapped so a parse slip cannot break xterm's parser; an
          // OSC handler returns whether it consumed the sequence.
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

    // Focus the terminal that fired a notification when the desktop shell
    // reports a click. `terminal:open` activates its tab or reopens the session.
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

// Run `fn`, swallowing errors so a malformed escape sequence cannot take the
// terminal's parser or bell handler down with it.
function guard(fn: () => void): void {
  try {
    fn();
  } catch (reason) {
    console.warn('xtralab: terminal notification handler failed', reason);
  }
}

// `guard` for an OSC handler that reports whether it consumed the sequence.
function guardOsc(fn: () => boolean): boolean {
  try {
    return fn();
  } catch (reason) {
    console.warn('xtralab: terminal notification handler failed', reason);
    return false;
  }
}

// Replace control characters with spaces (so a notification cannot carry escape
// sequences), collapse whitespace, and clamp the length.
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
