import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, MainAreaWidget } from '@jupyterlab/apputils';
import { Launcher, LauncherModel } from '@jupyterlab/launcher';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { launcherIcon } from '@jupyterlab/ui-components';
import { find } from '@lumino/algorithm';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { Widget } from '@lumino/widgets';

import {
  AGENTS,
  CREATE_LAUNCHER_COMMAND,
  agentCommandId,
  registerAgentCommands
} from './commands';

const PLUGIN_ID = 'xtralab:launcher';

const AGENT_CATEGORY = 'Agents';

/**
 * The xtralab launcher plugin. Replaces the stock JupyterLab launcher (which
 * is disabled via `package.json`'s `jupyterlab.disabledExtensions`) with a
 * pared-down launcher whose only cards are CLI agents (Claude, Codex,
 * Gemini). Clicking a card opens a fresh terminal in the main area and
 * pipes the agent's shell command into it.
 *
 * The plugin deliberately does NOT provide the `ILauncher` token: other
 * extensions register notebook/console/terminal cards on it as a side
 * effect, which would defeat the point of the agent-only launcher. If an
 * extension needs to surface itself, we'll add it here explicitly.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'An agent-focused launcher that replaces the default JupyterLab launcher.',
  autoStart: true,
  optional: [ILabShell, ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    labShell: ILabShell | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): void => {
    const { commands, shell } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    registerAgentCommands(app);

    // Seed the model with our agent cards. Using a single shared model
    // (instead of building a fresh one per launcher) means re-opening the
    // launcher tab is cheap and items added to the model later show up in
    // every existing launcher view.
    const model = new LauncherModel();
    for (const agent of AGENTS) {
      model.add({
        command: agentCommandId(agent.id),
        category: AGENT_CATEGORY,
        rank: agent.rank,
        categoryRank: 0
      });
    }

    commands.addCommand(CREATE_LAUNCHER_COMMAND, {
      label: trans.__('New Launcher'),
      execute: (args: ReadonlyPartialJSONObject) => {
        const id = Private.nextId();
        const callback = (item: Widget): void => {
          // When an agent command returns a Widget that ends up in the main
          // area, slot it where this launcher used to sit so opening an
          // agent feels like the launcher transformed into the terminal.
          if (find(shell.widgets('main'), w => w === item)) {
            shell.add(item, 'main', { ref: id });
            launcher.dispose();
          }
        };
        const launcher = new Launcher({
          model,
          cwd: '',
          callback,
          commands,
          translator: translator ?? nullTranslator
        });
        launcher.title.icon = launcherIcon;
        launcher.title.label = trans.__('Launcher');

        const main = new MainAreaWidget({ content: launcher });
        // Hide the close button when the launcher is the only thing in the
        // main area: closing it would leave the user staring at an empty
        // shell with no way back.
        main.title.closable = !!Array.from(shell.widgets('main')).length;
        main.id = id;

        shell.add(main, 'main', {
          activate: args['activate'] as boolean,
          ref: args['ref'] as string
        });

        if (labShell) {
          labShell.layoutModified.connect(() => {
            main.title.closable =
              Array.from(labShell.widgets('main')).length > 1;
          }, main);
        }

        return main;
      }
    });

    if (palette) {
      palette.addItem({
        command: CREATE_LAUNCHER_COMMAND,
        category: trans.__('Launcher')
      });
    }

    if (labShell) {
      void app.restored.then(() => {
        const maybeCreate = (): void => {
          if (labShell.isEmpty('main')) {
            void commands.execute(CREATE_LAUNCHER_COMMAND);
          }
        };
        labShell.layoutModified.connect(() => {
          maybeCreate();
        });
        // Layout has settled by the time `app.restored` resolves; if it's
        // empty (fresh start, no restored widgets) the connect above won't
        // fire on its own — kick it off here.
        maybeCreate();
      });

      labShell.addButtonEnabled = true;
      labShell.addRequested.connect((sender, arg) => {
        const ref =
          arg.currentTitle?.owner.id ||
          arg.titles[arg.titles.length - 1].owner.id;
        return commands.execute(CREATE_LAUNCHER_COMMAND, { ref });
      });
    }
  }
};

namespace Private {
  let counter = 0;

  /**
   * Returns the next unique launcher widget id.
   */
  export function nextId(): string {
    return `launcher-${counter++}`;
  }
}

export default plugin;
