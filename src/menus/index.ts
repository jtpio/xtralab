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
 * Hide the "Run" and "Kernel" top-level menus while no kernel-using widget
 * is open in the main area. The agent-first launcher does not use kernels,
 * so showing those menus on a fresh workspace surfaces commands the user
 * cannot meaningfully invoke; remove them until a notebook or console is
 * opened, then restore them at their original ranks.
 *
 * Detection is duck-typed on `sessionContext`: NotebookPanel and ConsolePanel
 * both expose it, which avoids pulling in `@jupyterlab/notebook` and
 * `@jupyterlab/console` just to identify their widgets.
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
    // The interface types (IRunMenu, IKernelMenu) extend IRankedMenu, but
    // the concrete instances are RankedMenu/Menu — cast so we can hand them
    // to MenuBar.removeMenu and IMainMenu.addMenu, which expect a `Menu`.
    const menuBar = mainMenu as unknown as MenuBar;
    const runMenu = mainMenu.runMenu as unknown as Menu;
    const kernelMenu = mainMenu.kernelMenu as unknown as Menu;

    // Capture the schema-assigned ranks so the menus reappear in their
    // original slots between View (rank 3) and Tabs (rank 500). Falling
    // back to the hard-coded defaults from `MainMenu` keeps things sane
    // if the schema ever omits the rank.
    const runRank = mainMenu.runMenu.rank ?? 4;
    const kernelRank = mainMenu.kernelMenu.rank ?? 5;

    const isPresent = (menu: Menu): boolean =>
      Array.from(menuBar.menus).indexOf(menu) > -1;

    const update = (): void => {
      const show = hasKernelWidget(labShell);
      if (show) {
        // Don't go through `mainMenu.addMenu`: it picks the insertion index
        // from a private `_items` array that `removeMenu` doesn't update,
        // so re-adding lands the menu at the wrong position. Insert
        // directly on the MenuBar by walking current menus and finding
        // the first sibling with a higher rank.
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
 * True iff any widget in the main area exposes a `sessionContext` — the
 * shared marker for NotebookPanel, ConsolePanel, and kernel-attached file
 * editors. We don't import their concrete types because that would drag
 * `@jupyterlab/notebook` and `@jupyterlab/console` into xtralab's bundle
 * just to do an `instanceof` check.
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
 * Insert `menu` into `menuBar` at the position dictated by `rank`, using
 * the existing menus' ranks to find the slot. Menus without a numeric
 * rank are treated as +Infinity so they sink to the end (matching the
 * convention in `MenuFactory.createMenus`).
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
