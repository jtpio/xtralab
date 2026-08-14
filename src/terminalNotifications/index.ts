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

// JupyterLab's terminal keeps its xterm in a private `_term` field; structural
// types use its hooks without `@xterm/xterm`, going inert (warning) if renamed.
/**
 * A handle returned by an xterm listener registration.
 */
interface IXtermDisposable {
  /**
   * Unregister the listener.
   */
  dispose(): void;
}
/**
 * The subset of the xterm.js API used to observe bells and OSC sequences.
 */
interface IXtermTerminal {
  /**
   * Register a handler invoked when the terminal bell rings.
   */
  onBell(handler: () => void): IXtermDisposable;
  /**
   * The escape-sequence parser used to register OSC handlers.
   */
  parser: {
    registerOscHandler(
      ident: number,
      callback: (data: string) => boolean
    ): IXtermDisposable;
  };
}
/**
 * A JupyterLab terminal widget content with its private xterm exposed.
 */
interface ITerminalContentInternals extends ITerminal.ITerminal {
  /**
   * A promise resolving once the underlying xterm exists.
   */
  ready: Promise<void>;
  /**
   * The private xterm instance; `undefined` if upstream renames the field.
   */
  _term?: IXtermTerminal;
}

type TerminalWidget = MainAreaWidget<ITerminal.ITerminal>;

// The renderer→main bridge the desktop shell injects on the lab window. Absent
// for pip-install users in a browser, who fall back to web Notifications.
/**
 * The desktop notification API exposed on `window.xtralab`.
 */
interface IDesktopBridge {
  /**
   * Show a native notification, tagged with the emitting terminal session.
   */
  notify?: (
    title: string,
    body: string,
    session?: string
  ) => Promise<void> | void;
  /**
   * Register a callback invoked with the tagged terminal session name when
   * the user clicks a notification.
   */
  onFocusTerminal?: (callback: (session: string) => void) => void;
}

/**
 * Turns the OSC 9 / OSC 777 / bell sequences agents emit into desktop
 * notifications via `window.xtralab.notify` (desktop) or the web Notifications
 * API — JupyterLab's xterm renders them but never forwards them to the OS.
 * The desktop shell advertises `TERM_PROGRAM=iTerm.app` so agents emit OSC 9.
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

    const lastNotified = new WeakMap<TerminalWidget, number>();
    const hooks = new WeakMap<TerminalWidget, IXtermDisposable[]>();

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
      // OSC 9 is overloaded: ConEmu/Windows Terminal use numeric subcommands
      // (e.g. `9 ; 4` progress); leave those unconsumed.
      if (/^\d+(;|$)/.test(data)) {
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
          if (widget.isDisposed) {
            return;
          }
          if (!term) {
            console.warn(
              'xtralab: xterm internals not found; terminal notifications are disabled for this terminal'
            );
            return;
          }
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
