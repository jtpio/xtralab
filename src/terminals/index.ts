import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { SessionRegistry } from './model';
import { RunningTerminals } from './widget';

const PLUGIN_ID = 'xtralab:terminals';

/**
 * Adds a left-sidebar panel that lists every running terminal session.
 *
 * This replaces the per-session status bar items: the bar grew unwieldy
 * once more than a couple of agents were running, whereas a dedicated
 * sidebar tab scales to an arbitrary number of sessions. It overlaps
 * with JupyterLab's own "Running Terminals and Kernels" panel, but that
 * one only shows `terminals/<n>` names — this panel reuses the same
 * label cache the status bar did, so each row shows the *real* title the
 * running program published (the launcher's agent name, or whatever
 * xterm escape sequence the process set), surviving a tab close.
 *
 * Clicking a row activates the existing tab if one is open, or reopens
 * the session in a fresh terminal widget (`terminal:open`). The inline
 * `×` button shuts the session down on the server. The header carries a
 * `+` button to open a brand-new terminal (`terminal:create-new`) and a
 * stop button to shut every session down at once (after a confirmation).
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'A left-sidebar panel listing every running terminal session by its real (program-published) title, with activate/reopen, shutdown and new-terminal actions.',
  autoStart: true,
  requires: [ITerminalTracker],
  optional: [ILayoutRestorer, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: ITerminalTracker,
    restorer: ILayoutRestorer | null,
    translator: ITranslator | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    const registry = new SessionRegistry(app.serviceManager, tracker);

    const onActivate = (name: string): void => {
      // `terminal:open` is the upstream entry point that handles both
      // sides of this: if a widget is already attached to the named
      // session it activates that tab, otherwise it spins up a fresh
      // widget connected to the live session.
      void app.commands.execute('terminal:open', { name });
    };

    const onShutdown = (name: string): void => {
      void app.serviceManager.terminals.shutdown(name).catch(reason => {
        console.error(
          `xtralab: failed to shut down terminal ${name}: ${reason}`
        );
      });
    };

    const onShutdownAll = (): void => {
      // Tearing down every session at once is hard to undo (each may be a
      // running agent), so confirm before calling the manager's bulk
      // shutdown. `runningChanged` then clears the list and the panel
      // re-renders empty.
      void showDialog({
        title: trans.__('Shut Down All Terminals?'),
        body: trans.__(
          'Are you sure you want to permanently shut down all running terminals?'
        ),
        buttons: [
          Dialog.cancelButton({ label: trans.__('Cancel') }),
          Dialog.warnButton({ label: trans.__('Shut Down All') })
        ]
      })
        .then(result => {
          if (result.button.accept) {
            return app.serviceManager.terminals.shutdownAll();
          }
        })
        .catch(reason => {
          console.error(
            `xtralab: failed to shut down all terminals: ${reason}`
          );
        });
    };

    const onCreate = (): void => {
      void app.commands.execute('terminal:create-new');
    };

    const panel = new RunningTerminals({
      registry,
      trans,
      onActivate,
      onShutdown,
      onShutdownAll,
      onCreate
    });

    // Sits just below the xtralab file browser (rank 50) so running
    // agents are one click away near the top of the sidebar. Sessions
    // restored from a previous lab run land via `runningChanged` once the
    // terminal manager is ready, which the panel's `UseSignal` picks up.
    app.shell.add(panel, 'left', { rank: 60 });
    if (restorer) {
      restorer.add(panel, panel.id);
    }
  }
};

export default plugin;
