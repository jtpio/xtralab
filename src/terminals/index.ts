import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { LabIcon, MenuSvg, terminalIcon } from '@jupyterlab/ui-components';

import { IAgentSessions } from '../agentSessions';
import { IEditorRegistry } from '../launcher/editorRegistry';
import { agentCommandId, IAgentRegistry } from '../launcher/tokens';
import { AgentTerminals } from './agentTerminals';
import { SessionRegistry } from './model';
import { IAgentTerminals } from './tokens';
import { RunningTerminals } from './widget';

const PLUGIN_ID = 'xtralab:terminals';

/**
 * Adds a left-sidebar panel that lists every running terminal session.
 *
 * Each row is labelled with the *real* title the running program
 * published — the launcher's agent name, or whatever title an xterm
 * escape sequence set — which the registry caches so it survives the
 * user closing the tab while the session keeps running on the server.
 * JupyterLab's built-in "Running Terminals and Kernels" panel lists the
 * same sessions but only by their `terminals/<n>` name, so this panel
 * resolves and caches the published title to show something meaningful.
 * Rows running a coding agent carry a smaller second line below the
 * title with the agent's latest line of output, so the panel shows what
 * each agent is doing at a glance — on by default, and switchable off
 * through the `showAgentActivity` setting.
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
 *
 * The plugin also provides {@link IAgentTerminals} — the sessions with a
 * detection-confirmed running agent, plus a "paste a prompt into one"
 * action — which the ask-agent popup uses to offer running agents as
 * targets next to "new terminal".
 */
const plugin: JupyterFrontEndPlugin<IAgentTerminals> = {
  id: PLUGIN_ID,
  description:
    'A left-sidebar panel listing every running terminal session by its real (program-published) title, with activate/reopen, shutdown and new-terminal actions.',
  autoStart: true,
  provides: IAgentTerminals,
  requires: [ITerminalTracker],
  optional: [
    ILayoutRestorer,
    ITranslator,
    IAgentRegistry,
    IEditorRegistry,
    IAgentSessions,
    ISettingRegistry
  ],
  activate: (
    app: JupyterFrontEnd,
    tracker: ITerminalTracker,
    restorer: ILayoutRestorer | null,
    translator: ITranslator | null,
    agentRegistry: IAgentRegistry | null,
    editorRegistry: IEditorRegistry | null,
    agentSessions: IAgentSessions | null,
    settingRegistry: ISettingRegistry | null
  ): IAgentTerminals => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // Resolve a running agent/editor identifier to an icon: the matching
    // agent's logo, the matching editor's logo (Neovim/Vim), or the plain
    // terminal icon when nothing recognised is running. Detection reports
    // either the configured `command` or the canonical `id` (see
    // `detectCommands`), so a row whose command is an alias — e.g. `ccm` for
    // `claude` — still resolves to the right logo via its id. Reads the
    // registries live so it tracks settings changes. Used to badge each row.
    const iconForCommand = (command: string | null): LabIcon => {
      if (!command) {
        return terminalIcon;
      }
      const agent = agentRegistry?.agents.find(
        a => a.command === command || a.id === command
      );
      if (agent) {
        return agent.icon;
      }
      // A terminal running an editor (Neovim/Vim, or a user-configured one) is
      // badged with its logo, the same as an agent.
      const editor = editorRegistry?.editors.find(
        e => e.command === command || e.id === command
      );
      return editor?.icon ?? terminalIcon;
    };

    // The names the server should look for in each terminal's process tree:
    // for every agent and editor, its configured `command` plus its canonical
    // `id`. The id is the real CLI name (e.g. `claude`, `nvim`), so an agent
    // whose command points at an alias — e.g. `ccm` running `claude` — is
    // still recognised by the process it actually spawns. Read live so the
    // list tracks settings changes; deduplicated since command and id usually
    // coincide.
    const detectCommands = (): string[] => {
      const names = new Set<string>();
      for (const agent of agentRegistry?.agents ?? []) {
        names.add(agent.command);
        names.add(agent.id);
      }
      for (const editor of editorRegistry?.editors ?? []) {
        names.add(editor.command);
        names.add(editor.id);
      }
      return Array.from(names);
    };

    // Whether a detected command/id belongs to a coding agent rather than an
    // editor. Only agent sessions get a latest-activity line (editor
    // terminals stay badge-only), and only they are offered as prompt
    // targets through `IAgentTerminals`.
    const isAgentCommand = (command: string): boolean =>
      agentRegistry?.agents.some(
        a => a.command === command || a.id === command
      ) ?? false;

    const registry = new SessionRegistry({
      serviceManager: app.serviceManager,
      tracker,
      // The shell tells the registry which widget is current, so the panel can
      // highlight the terminal that is the current main-area widget (and
      // nothing while a notebook or other widget is current instead).
      shell: app.shell,
      agentSessions,
      detectCommands,
      isAgentCommand
    });

    // Mirror the agent/editor detected in each open terminal onto its main-area
    // tab icon, so the tab matches its sidebar row. Re-running on every
    // `stateChanged` is safe: `Title.icon` ignores an unchanged assignment, so
    // the writes neither loop nor churn.
    const syncTabIcons = (): void => {
      tracker.forEach(widget => {
        const session = widget.content.session;
        if (!session) {
          return;
        }
        widget.title.icon = iconForCommand(
          registry.agentCommandFor(session.name)
        );
      });
    };
    registry.stateChanged.connect(syncTabIcons);
    syncTabIcons();

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
    // the button opens a plain terminal directly in one click.
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

    // Added to the left sidebar. The shipped `layout` setting in
    // jupyter-config/labconfig gives each sidebar widget a default rank —
    // this Terminals panel ranks first, so running agents sit one click
    // away at the top. That setting assigns rank only and pins no area, so
    // the "Move Widget" context menu can relocate the panel and the layout
    // restorer remembers where the user puts it. The `rank` here is the
    // in-code fallback used when the setting is absent. Sessions restored
    // from a previous lab run land via `runningChanged` once the terminal
    // manager is ready, which the panel's `UseSignal` picks up.
    app.shell.add(panel, 'left', { rank: 1 });
    if (restorer) {
      restorer.add(panel, panel.id);
    }

    // The latest-activity line under each agent row is on by default; honour
    // the `showAgentActivity` setting so it can be turned off. Read on load and
    // re-applied on every change.
    if (settingRegistry) {
      settingRegistry
        .load(PLUGIN_ID)
        .then(settings => {
          const applyActivitySetting = (): void => {
            registry.setActivityEnabled(
              boolOption(settings.composite.showAgentActivity, true)
            );
          };
          applyActivitySetting();
          // Bind the slot to the panel so disposing the panel (which clears
          // its signal data) drops the connection — the disposed registry is
          // then never reached on a later settings change.
          settings.changed.connect(applyActivitySetting, panel);
        })
        .catch(reason => {
          console.error(
            `xtralab: failed to load ${PLUGIN_ID} settings`,
            reason
          );
        });
    }

    return new AgentTerminals({
      registry,
      tracker,
      commands: app.commands,
      terminals: app.serviceManager.terminals,
      detectCommands,
      isAgentCommand,
      trans
    });
  }
};

/** Read a boolean setting value, falling back when it is missing or invalid. */
function boolOption(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export default plugin;
