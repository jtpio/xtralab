import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IStatusBar } from '@jupyterlab/statusbar';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { DisposableSet, type IDisposable } from '@lumino/disposable';

import { SessionRegistry, TerminalSessionItem } from './widget';

const PLUGIN_ID = 'xtralab:statusBar';

/**
 * Surfaces every running terminal session as its own item on the left
 * side of the status bar. The list is driven by
 * `serviceManager.terminals.runningChanged`, not by the widget tracker,
 * so a session that has its tab closed but is still running on the
 * backend keeps its slot — the typical state for an agent the user has
 * stepped away from. Clicking an item activates the existing tab if one
 * is open, or reopens the session in a fresh terminal widget. The
 * inline `×` button shuts the session down on the server, which
 * cascades through the widget if it is currently open.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Surface each running terminal session as its own status bar item so users can jump to (or reopen) backgrounded agents from anywhere in the workspace.',
  autoStart: true,
  requires: [IStatusBar, ITerminalTracker],
  optional: [ITranslator],
  activate: (
    app: JupyterFrontEnd,
    statusBar: IStatusBar,
    tracker: ITerminalTracker,
    translator: ITranslator | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    const registry = new SessionRegistry(app.serviceManager, tracker);

    // One DisposableSet per session — registerStatusItem returns an
    // IDisposable for the registration, and the item widget itself
    // implements IDisposable. Bundling them lets a single `dispose()`
    // tear the slot down completely when the session goes away.
    const items = new Map<string, IDisposable>();

    const onActivate = (name: string): void => {
      // `terminal:open` is the upstream entry point that handles both
      // sides of this: if a widget is already attached to the named
      // session it activates that tab, otherwise it spins up a fresh
      // widget connected to the live session. Reusing it keeps the
      // path identical to a click in the running-sessions sidebar.
      void app.commands.execute('terminal:open', { name });
    };

    const onShutdown = (name: string): void => {
      void app.serviceManager.terminals.shutdown(name).catch(reason => {
        console.error(
          `xtralab: failed to shut down terminal ${name}: ${reason}`
        );
      });
    };

    const sync = (): void => {
      const live = new Set(registry.sessionNames());

      // Add items for newly-seen sessions. We register each at its
      // stable rank from the registry so re-creating an item between
      // syncs (e.g. if we ever decide to swap representations) lands
      // in the same slot.
      for (const name of live) {
        if (items.has(name)) {
          continue;
        }
        const item = new TerminalSessionItem({
          registry,
          sessionName: name,
          trans,
          onActivate,
          onShutdown
        });
        const registration = statusBar.registerStatusItem(
          `${PLUGIN_ID}:${name}`,
          {
            item,
            align: 'left',
            rank: registry.rankFor(name)
          }
        );
        const set = new DisposableSet();
        set.add(registration);
        set.add(item);
        items.set(name, set);
      }

      // Remove items for sessions the server no longer knows about.
      for (const [name, disposable] of Array.from(items.entries())) {
        if (!live.has(name)) {
          disposable.dispose();
          items.delete(name);
        }
      }
    };

    registry.stateChanged.connect(sync);
    void app.serviceManager.terminals.ready.then(() => {
      // The first `runningChanged` may have fired before our connect,
      // depending on how the manager initialises — refresh once after
      // it is ready so any pre-existing sessions get their items.
      sync();
    });
  }
};

export default plugin;
