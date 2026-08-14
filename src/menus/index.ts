import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IMainMenu } from '@jupyterlab/mainmenu';
import type { IRankedMenu } from '@jupyterlab/ui-components';
import type { Menu, MenuBar, Widget } from '@lumino/widgets';

const PLUGIN_ID = 'xtralab:menus';

/**
 * Hide the Run and Kernel menus while no kernel-using widget is open in the
 * main area, then restore them at their original ranks — the agent-first
 * launcher does not use kernels, so a fresh workspace should not surface them.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Toggle the Run and Kernel main menus based on whether any kernel-using widget is open.',
  autoStart: true,
  requires: [IMainMenu, ILabShell],
  activate: (
    app: JupyterFrontEnd,
    mainMenu: IMainMenu,
    labShell: ILabShell
  ): void => {
    // The interface types extend IRankedMenu but the concrete instances are
    // RankedMenu/Menu; cast for the MenuBar methods, which expect a `Menu`.
    const menuBar = mainMenu as unknown as MenuBar;
    const runMenu = mainMenu.runMenu as unknown as Menu;
    const kernelMenu = mainMenu.kernelMenu as unknown as Menu;

    // Schema-assigned ranks so the menus reappear in their original slots;
    // fall back to MainMenu's hard-coded defaults if the schema omits them.
    const runRank = mainMenu.runMenu.rank ?? 4;
    const kernelRank = mainMenu.kernelMenu.rank ?? 5;

    const isPresent = (menu: Menu): boolean =>
      Array.from(menuBar.menus).indexOf(menu) > -1;

    const update = (): void => {
      const show = hasKernelWidget(labShell);
      if (show) {
        // Not `mainMenu.addMenu`: its insertion index comes from a private
        // `_items` array that `removeMenu` doesn't update, misplacing re-adds.
        if (!isPresent(runMenu)) {
          insertByRank(menuBar, runMenu, runRank);
        }
        if (!isPresent(kernelMenu)) {
          insertByRank(menuBar, kernelMenu, kernelRank);
        }
      } else {
        if (isPresent(runMenu)) {
          menuBar.removeMenu(runMenu);
        }
        if (isPresent(kernelMenu)) {
          menuBar.removeMenu(kernelMenu);
        }
      }
    };

    void app.restored.then(() => {
      update();
      labShell.layoutModified.connect(update);
    });
  }
};

/**
 * True iff any main-area widget exposes a `sessionContext` (NotebookPanel,
 * ConsolePanel, kernel-attached editors) — duck-typed to keep
 * `@jupyterlab/notebook` and `@jupyterlab/console` out of the bundle.
 */
function hasKernelWidget(labShell: ILabShell): boolean {
  for (const widget of labShell.widgets('main')) {
    if (hasSessionContext(widget)) {
      return true;
    }
  }
  return false;
}

function hasSessionContext(widget: Widget): boolean {
  const candidate = widget as unknown as { sessionContext?: unknown };
  return (
    candidate.sessionContext !== null && candidate.sessionContext !== undefined
  );
}

/**
 * Insert `menu` at the slot dictated by `rank`; rank-less menus count as
 * +Infinity and sink to the end, matching `MenuFactory.createMenus`.
 */
function insertByRank(menuBar: MenuBar, menu: Menu, rank: number): void {
  const menus = menuBar.menus;
  for (let i = 0; i < menus.length; i++) {
    const r = (menus[i] as unknown as IRankedMenu).rank;
    const otherRank = typeof r === 'number' ? r : Number.POSITIVE_INFINITY;
    if (otherRank > rank) {
      menuBar.insertMenu(i, menu);
      return;
    }
  }
  menuBar.addMenu(menu);
}

export default plugin;
