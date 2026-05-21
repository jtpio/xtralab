import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { LabIcon, MenuSvg, terminalIcon } from '@jupyterlab/ui-components';

import { IAgentSessions } from '../agentSessions';
import { agentCommandId, IAgentRegistry } from '../launcher/tokens';
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
 * `+` button and a stop button (the latter shuts every session down at
 * once, after a confirmation).
 *
 * The `+` button drops down a menu — built from the launcher's shared
 * `IAgentRegistry` — listing each available agent (Claude, Codex, …)
 * followed by a plain terminal, so starting an agent session is as
 * consistent here as in the launcher and reuses the very same registered
 * commands and icons. When the launcher is disabled or no agents are
 * installed, the button falls back to opening a plain terminal directly.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'A left-sidebar panel listing every running terminal session by its real (program-published) title, with activate/reopen, shutdown and new-terminal actions.',
  autoStart: true,
  requires: [ITerminalTracker],
  optional: [ILayoutRestorer, ITranslator, IAgentRegistry, IAgentSessions],
  activate: (
    app: JupyterFrontEnd,
    tracker: ITerminalTracker,
    restorer: ILayoutRestorer | null,
    translator: ITranslator | null,
    agentRegistry: IAgentRegistry | null,
    agentSessions: IAgentSessions | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // Resolve a session's running-agent command to an icon: the matching
    // agent's logo, or the plain terminal icon when nothing (recognised) is
    // running. Reads `agentRegistry.agents` live so it tracks settings
    // changes. Used by the panel to badge each row.
    const iconForCommand = (command: string | null): LabIcon => {
      if (!command) {
        return terminalIcon;
      }
      const agent = agentRegistry?.agents.find(a => a.command === command);
      return agent?.icon ?? terminalIcon;
    };

    const registry = new SessionRegistry({
      serviceManager: app.serviceManager,
      tracker,
      // The shell tells the registry which widget is current, so the panel can
      // highlight the terminal that is the current main-area widget (and
      // nothing while a notebook or other widget is current instead).
      shell: app.shell,
      agentSessions,
      // The commands the server should look for, derived live from the
      // current agent list so it tracks settings changes.
      detectCommands: () => agentRegistry?.agents.map(a => a.command) ?? []
    });

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

    // The header "+" button. With the launcher's agent registry available
    // it drops down a menu of the available agents (reusing their registered
    // `xtralab:start-agent:<id>` commands, so the icons and labels match the
    // launcher exactly) followed by a separator and a plain terminal. Built
    // lazily and repopulated on each open so it always reflects the current,
    // settings-driven agent list. Without the registry (launcher disabled)
    // or with no agents installed, there is nothing to choose between, so
    // the button keeps the original one-click "new terminal" behavior.
    //
    // `MenuSvg` (not the bare Lumino `Menu`) is what every JupyterLab menu
    // uses: its renderer applies the `menuItem` LabIcon stylesheet, which
    // sizes the agent icons to 16px and centers them vertically — the bare
    // `Menu` renders the raw, oversized, misaligned SVGs.
    let newMenu: MenuSvg | null = null;
    const onCreate = (anchor: { x: number; y: number }): void => {
      const agents = agentRegistry?.agents ?? [];
      if (agents.length === 0) {
        void app.commands.execute('terminal:create-new');
        return;
      }
      if (!newMenu) {
        newMenu = new MenuSvg({ commands: app.commands });
      }
      newMenu.clearItems();
      for (const agent of agents) {
        newMenu.addItem({ command: agentCommandId(agent.id) });
      }
      newMenu.addItem({ type: 'separator' });
      newMenu.addItem({ command: 'terminal:create-new' });
      newMenu.open(anchor.x, anchor.y);
    };

    const panel = new RunningTerminals({
      registry,
      trans,
      iconForCommand,
      onActivate,
      onShutdown,
      onShutdownAll,
      onCreate
    });

    // Added to the left sidebar. The shipped default tab order is set by
    // the shell `layout` override in jupyter-config/labconfig (which puts
    // this Terminals panel first, so running agents are one click away at
    // the top of the sidebar); the `rank` below is only the in-code
    // fallback used when that override is absent. Sessions restored from a
    // previous lab run land via `runningChanged` once the terminal manager
    // is ready, which the panel's `UseSignal` picks up.
    app.shell.add(panel, 'left', { rank: 60 });
    if (restorer) {
      restorer.add(panel, panel.id);
    }
  }
};

export default plugin;
