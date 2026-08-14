import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  IMovableSectionRegistry,
  showDialog
} from '@jupyterlab/apputils';
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
 * Left-sidebar panel listing every running terminal session by the real title
 * the running program published (cached so it survives closing the tab), with
 * agent logo badges, an optional latest-activity line, and launch/shutdown
 * actions. Also provides {@link IAgentTerminals} for the ask-agent popup.
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
    ISettingRegistry,
    IMovableSectionRegistry
  ],
  activate: (
    app: JupyterFrontEnd,
    tracker: ITerminalTracker,
    restorer: ILayoutRestorer | null,
    translator: ITranslator | null,
    agentRegistry: IAgentRegistry | null,
    editorRegistry: IEditorRegistry | null,
    agentSessions: IAgentSessions | null,
    settingRegistry: ISettingRegistry | null,
    movableSections: IMovableSectionRegistry | null
  ): IAgentTerminals => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // Detection reports either the configured `command` or the canonical `id`,
    // so an aliased command (e.g. `ccm` for `claude`) still maps to its logo.
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
      const editor = editorRegistry?.editors.find(
        e => e.command === command || e.id === command
      );
      return editor?.icon ?? terminalIcon;
    };

    // Each agent/editor's `command` plus its canonical `id` (the real CLI
    // name), so an aliased command is still recognised by the process it spawns.
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

    // Only agent sessions get a latest-activity line and are offered as
    // prompt targets; editor terminals stay badge-only.
    const isAgentCommand = (command: string): boolean =>
      agentRegistry?.agents.some(
        a => a.command === command || a.id === command
      ) ?? false;

    const registry = new SessionRegistry({
      serviceManager: app.serviceManager,
      tracker,
      shell: app.shell,
      agentSessions,
      detectCommands,
      isAgentCommand
    });

    // Mirror the detected agent/editor onto each open tab's icon. `Title.icon`
    // ignores an unchanged assignment, so re-running per stateChanged is cheap.
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
      // `terminal:open` activates an attached tab or spins up a fresh widget
      // connected to the live session.
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

    // `MenuSvg`, not the bare Lumino `Menu`: its renderer applies the `menuItem`
    // LabIcon stylesheet — the bare menu renders raw, oversized SVGs.
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

    // The shipped labconfig `layout` setting ranks this panel first (rank only,
    // no area pin, so "Move Widget" works); this rank is the fallback.
    app.shell.add(panel, 'left', { rank: 1 });
    if (restorer) {
      restorer.add(panel, panel.id);
    }

    void app.restored.then(() => {
      panel.expandOwnSection();
    });

    if (movableSections) {
      movableSections.registerSource(PLUGIN_ID, trans.__('Terminals'), panel);
      movableSections.registerTarget(PLUGIN_ID, trans.__('Terminals'), panel);
      panel.announceSections();
    }

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
          // Bound to the panel so disposing it drops the connection — the
          // disposed registry is never reached on a later settings change.
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
      terminals: app.serviceManager.terminals,
      detectCommands,
      isAgentCommand,
      trans
    });
  }
};

/**
 * Read a boolean setting value, falling back when it is missing or invalid.
 */
function boolOption(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export default plugin;
