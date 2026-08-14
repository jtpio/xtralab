import { JupyterFrontEnd } from '@jupyterlab/application';
import {
  Clipboard,
  Dialog,
  ICommandPalette,
  InputDialog,
  showDialog,
  showErrorMessage
} from '@jupyterlab/apputils';
import { PageConfig, PathExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import {
  addIcon,
  closeIcon,
  collapseAllIcon,
  CommandToolbarButton,
  copyIcon,
  downloadIcon,
  editIcon,
  fileIcon,
  filterIcon,
  IDisposableMenuItem,
  newFolderIcon,
  RankedMenu,
  refreshIcon
} from '@jupyterlab/ui-components';
import { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { ContextMenu, Widget } from '@lumino/widgets';

import { toCanonicalPath, toServerPath } from './contents';
import { FILE_BROWSER_ID, IXtralabFileBrowser } from './widget';

/**
 * Command ids for the xtralab browser. Namespaced `xtralab:` rather than
 * reusing the `filebrowser:` ids: the core handlers resolve their target via
 * `IFileBrowserFactory.tracker`, which never sees this widget.
 */
export namespace CommandIDs {
  export const open = 'xtralab:open';
  export const openBrowserTab = 'xtralab:open-browser-tab';
  export const rename = 'xtralab:rename';
  export const del = 'xtralab:delete';
  export const duplicate = 'xtralab:duplicate';
  export const copyPath = 'xtralab:copy-path';
  export const download = 'xtralab:download';
  export const refresh = 'xtralab:refresh';
  export const collapseAll = 'xtralab:collapse-all';
  export const toggleFileFilter = 'xtralab:toggle-file-filter';
  export const createNewDirectory = 'xtralab:create-new-directory';
  export const newLauncher = 'xtralab:new-launcher';
  export const revealPath = 'xtralab:reveal-path';
  export const revealInFileTree = 'xtralab:reveal-in-file-tree';
}

/**
 * "Open With" submenu id. Distinct from the core `jp-contextmenu-open-with`
 * so the core's populator does not fill ours from its own selection.
 */
const OPEN_WITH_SUBMENU_ID = 'jp-contextmenu-xtralab-open-with';

interface IRegisterCommandsOptions {
  app: JupyterFrontEnd;
  browser: IXtralabFileBrowser;
  docManager: IDocumentManager;
  palette: ICommandPalette | null;
  translator: ITranslator | null;
}

/**
 * Path of the right-clicked item, from the contextmenu event's target;
 * falls back to the tree selection when invoked without one (the palette).
 */
function getTargetPath(
  app: JupyterFrontEnd,
  browser: IXtralabFileBrowser
): string | undefined {
  const node = app.contextMenuHitTest(
    n => n.dataset !== undefined && n.dataset.type === 'item'
  );
  const fromContext = node?.dataset.itemPath;
  if (fromContext !== undefined && fromContext.length > 0) {
    return fromContext;
  }
  return browser.selectedPaths[0];
}

/**
 * Kind of the right-clicked item, from the data attributes on
 * `@pierre/trees` rows; `undefined` when the target is not a tree item.
 */
function getTargetKind(app: JupyterFrontEnd): 'file' | 'folder' | undefined {
  const node = app.contextMenuHitTest(
    n => n.dataset !== undefined && n.dataset.type === 'item'
  );
  const kind = node?.dataset.itemType;
  return kind === 'file' || kind === 'folder' ? kind : undefined;
}

/**
 * Canonical paths "Open" acts on: the whole selection when the right-clicked
 * row is part of it (matching the default browser), else just that row.
 * Folders are filtered out — this tree has no "current directory".
 */
function getOpenPaths(
  app: JupyterFrontEnd,
  browser: IXtralabFileBrowser
): string[] {
  const node = app.contextMenuHitTest(
    n => n.dataset !== undefined && n.dataset.type === 'item'
  );
  const fromContext = node?.dataset.itemPath;
  const selection = browser.selectedPaths;

  let candidates: readonly string[];
  if (fromContext !== undefined && fromContext.length > 0) {
    candidates = selection.includes(fromContext) ? selection : [fromContext];
  } else {
    candidates = selection;
  }
  return candidates.filter(path => !path.endsWith('/'));
}

/**
 * True iff there is an actionable target for a command on the right-click.
 */
function hasTarget(
  app: JupyterFrontEnd,
  browser: IXtralabFileBrowser
): boolean {
  return getTargetPath(app, browser) !== undefined;
}

/**
 * Working directory for create actions: a selected folder is its own cwd, a
 * file falls back to its parent; empty string (the contents-API root) when
 * nothing is selected.
 */
function getWorkingDirectory(browser: IXtralabFileBrowser): string {
  const first = browser.selectedPaths[0];
  if (first === undefined || first.length === 0) {
    return '';
  }
  const serverPath = toServerPath(first);
  if (first.endsWith('/')) {
    return serverPath;
  }
  return PathExt.dirname(serverPath);
}

/**
 * Main-area widget whose tab is the target of the current context-menu
 * event, or `null`. `contextMenuHitTest` reads the last context-menu event,
 * which is not cleared when the menu closes, so callers must gate against
 * resolving a stale tab.
 */
function contextMenuTabWidget(app: JupyterFrontEnd): Widget | null {
  const node = app.contextMenuHitTest(
    n => n.dataset !== undefined && n.dataset.type === 'document-title'
  );
  const id = node?.dataset.id;
  if (id === undefined) {
    return null;
  }
  for (const widget of app.shell.widgets('main')) {
    if (widget.id === id) {
      return widget;
    }
  }
  return null;
}

/**
 * Canonical path of the document to reveal: the right-clicked tab when
 * `fromContextMenu` is true (the file-tab menu), else the active main-area
 * widget (the palette).
 */
function documentPathToReveal(
  app: JupyterFrontEnd,
  docManager: IDocumentManager,
  fromContextMenu: boolean
): string | undefined {
  const widget =
    (fromContextMenu ? contextMenuTabWidget(app) : null) ??
    app.shell.currentWidget;
  if (widget === null) {
    return undefined;
  }
  const path = docManager.contextForWidget(widget)?.path ?? '';
  return path.length > 0 ? path : undefined;
}

/**
 * Build the populator that fills the "Open With" submenu on every
 * context-menu open, mirroring `filebrowser-extension:open-with`.
 * `preferredWidgetFactories(path)` is path-only, so the populator stays
 * synchronous and the submenu is ready before the user can hover.
 */
function makeOpenWithUpdater(
  app: JupyterFrontEnd,
  browser: IXtralabFileBrowser
): (contextMenu: ContextMenu) => void {
  let items: IDisposableMenuItem[] = [];

  return (contextMenu: ContextMenu): void => {
    items.forEach(item => item.dispose());
    items = [];

    const submenu =
      (contextMenu.menu.items.find(
        item =>
          item.type === 'submenu' && item.submenu?.id === OPEN_WITH_SUBMENU_ID
      )?.submenu as RankedMenu | undefined) ?? null;
    if (submenu === null) {
      return;
    }
    submenu.clearItems();

    if (getTargetKind(app) !== 'file') {
      return;
    }
    const targetPath = getTargetPath(app, browser);
    if (targetPath === undefined) {
      return;
    }
    const serverPath = toServerPath(targetPath);
    const factories = app.docRegistry.preferredWidgetFactories(serverPath);
    items = factories.map(factory =>
      submenu.addItem({
        args: { factory: factory.name, label: factory.label || factory.name },
        command: CommandIDs.open
      })
    );
  };
}

/**
 * Register the xtralab commands, context-menu wiring, and the dynamic
 * "Open With" populator. Returns a detach function; the commands themselves
 * stay owned by the registry.
 */
export function registerCommands(opts: IRegisterCommandsOptions): () => void {
  const { app, browser, docManager, palette, translator } = opts;
  const { commands } = app;
  const trans = (translator ?? nullTranslator).load('jupyterlab');

  commands.addCommand(CommandIDs.open, {
    label: args =>
      ((args.label as string) ??
        (args.factory as string) ??
        trans.__('Open')) as string,
    icon: args => {
      const factoryName = args.factory as string | undefined;
      if (factoryName !== undefined) {
        const fileType = app.docRegistry.getFileType(factoryName);
        return fileType?.icon?.bindprops({ stylesheet: 'menuItem' });
      }
      return fileIcon.bindprops({ stylesheet: 'menuItem' });
    },
    mnemonic: 0,
    isEnabled: () => getOpenPaths(app, browser).length > 0,
    execute: async (args: ReadonlyPartialJSONObject) => {
      const targets = getOpenPaths(app, browser);
      if (targets.length === 0) {
        return;
      }
      const factory = (args.factory as string | undefined) ?? undefined;
      await Promise.all(
        targets.map(target =>
          commands.execute('docmanager:open', {
            path: toServerPath(target),
            factory
          })
        )
      );
    }
  });

  commands.addCommand(CommandIDs.openBrowserTab, {
    label: trans.__('Open in New Browser Tab'),
    icon: fileIcon.bindprops({ stylesheet: 'menuItem' }),
    isEnabled: () => getTargetKind(app) === 'file',
    isVisible: () => getTargetKind(app) === 'file',
    execute: async () => {
      const targetPath = getTargetPath(app, browser);
      if (targetPath === undefined) {
        return;
      }
      return commands.execute('docmanager:open-browser-tab', {
        path: toServerPath(targetPath)
      });
    }
  });

  commands.addCommand(CommandIDs.rename, {
    label: trans.__('Rename…'),
    icon: editIcon.bindprops({ stylesheet: 'menuItem' }),
    mnemonic: 0,
    isEnabled: () => hasTarget(app, browser),
    execute: async () => {
      const targetPath = getTargetPath(app, browser);
      if (targetPath === undefined) {
        return;
      }
      const serverPath = toServerPath(targetPath);
      const oldName = PathExt.basename(serverPath);
      const result = await InputDialog.getText({
        title: trans.__('Rename'),
        label: trans.__('Enter a new name'),
        text: oldName,
        okLabel: trans.__('Rename')
      });
      const newName = result.value?.trim();
      if (
        result.button.accept !== true ||
        newName === undefined ||
        newName.length === 0 ||
        newName === oldName
      ) {
        return;
      }
      const newPath = PathExt.join(PathExt.dirname(serverPath), newName);
      try {
        await browser.contentsManager.rename(serverPath, newPath);
        browser.refresh();
      } catch (err) {
        await showErrorMessage(trans.__('Rename failed'), err as Error);
      }
    }
  });

  commands.addCommand(CommandIDs.del, {
    label: () =>
      PageConfig.getOption('delete_to_trash') === 'true'
        ? trans.__('Move to Trash')
        : trans.__('Delete'),
    icon: closeIcon.bindprops({ stylesheet: 'menuItem' }),
    mnemonic: 0,
    isEnabled: () => hasTarget(app, browser),
    execute: async () => {
      const targetPath = getTargetPath(app, browser);
      if (targetPath === undefined) {
        return;
      }
      const serverPath = toServerPath(targetPath);
      const trashing = PageConfig.getOption('delete_to_trash') === 'true';
      const result = await showDialog({
        title: trashing ? trans.__('Move to Trash') : trans.__('Delete'),
        body: trashing
          ? trans.__('Are you sure you want to move to trash: %1?', serverPath)
          : trans.__(
              'Are you sure you want to permanently delete: %1?',
              serverPath
            ),
        buttons: [
          Dialog.cancelButton(),
          Dialog.warnButton({
            label: trashing ? trans.__('Move to Trash') : trans.__('Delete')
          })
        ]
      });
      if (result.button.accept !== true) {
        return;
      }
      try {
        await browser.contentsManager.delete(serverPath);
        browser.refresh();
      } catch (err) {
        await showErrorMessage(trans.__('Delete failed'), err as Error);
      }
    }
  });

  commands.addCommand(CommandIDs.duplicate, {
    label: trans.__('Duplicate'),
    icon: copyIcon.bindprops({ stylesheet: 'menuItem' }),
    isEnabled: () => getTargetKind(app) === 'file',
    isVisible: () => getTargetKind(app) === 'file',
    execute: async () => {
      const targetPath = getTargetPath(app, browser);
      if (targetPath === undefined) {
        return;
      }
      const serverPath = toServerPath(targetPath);
      const dir = PathExt.dirname(serverPath);
      try {
        const created = await browser.contentsManager.copy(serverPath, dir);
        browser.notifyPathAdded(toCanonicalPath(created));
      } catch (err) {
        await showErrorMessage(trans.__('Duplicate failed'), err as Error);
      }
    }
  });

  commands.addCommand(CommandIDs.copyPath, {
    label: trans.__('Copy Path'),
    icon: fileIcon.bindprops({ stylesheet: 'menuItem' }),
    isEnabled: () => hasTarget(app, browser),
    execute: async () => {
      const targetPath = getTargetPath(app, browser);
      if (targetPath === undefined) {
        return;
      }
      const serverPath = toServerPath(targetPath);
      if (PageConfig.getOption('copyAbsolutePath') === 'true') {
        Clipboard.copyToSystem(
          PathExt.joinWithLeadingSlash(
            PageConfig.getOption('serverRoot') ?? '',
            serverPath
          )
        );
      } else {
        Clipboard.copyToSystem(serverPath);
      }
    }
  });

  commands.addCommand(CommandIDs.download, {
    label: trans.__('Download'),
    icon: downloadIcon.bindprops({ stylesheet: 'menuItem' }),
    isEnabled: () => getTargetKind(app) === 'file',
    isVisible: () => getTargetKind(app) === 'file',
    execute: async () => {
      const targetPath = getTargetPath(app, browser);
      if (targetPath === undefined) {
        return;
      }
      const serverPath = toServerPath(targetPath);
      try {
        const url = await browser.contentsManager.getDownloadUrl(serverPath);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = '';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      } catch (err) {
        await showErrorMessage(trans.__('Download failed'), err as Error);
      }
    }
  });

  commands.addCommand(CommandIDs.refresh, {
    label: trans.__('Refresh File List'),
    caption: trans.__('Refresh the file browser'),
    icon: refreshIcon.bindprops({ stylesheet: 'menuItem' }),
    execute: () => {
      browser.refresh();
    }
  });

  commands.addCommand(CommandIDs.collapseAll, {
    label: trans.__('Collapse All Folders'),
    caption: trans.__('Collapse all folders in the file browser'),
    icon: collapseAllIcon.bindprops({ stylesheet: 'menuItem' }),
    execute: () => {
      browser.collapseAll();
    }
  });

  commands.addCommand(CommandIDs.toggleFileFilter, {
    label: trans.__('Toggle File Filter'),
    caption: trans.__('Show or hide the file filter'),
    icon: filterIcon.bindprops({ stylesheet: 'menuItem' }),
    isToggled: () => browser.fileFilterVisible,
    execute: () => {
      browser.toggleFileFilter();
    }
  });

  // The filter can also auto-show when typing with the tree focused, so
  // track visibility changes rather than the command's own executions.
  const onFilterVisibleChanged = (): void => {
    commands.notifyCommandChanged(CommandIDs.toggleFileFilter);
  };
  browser.fileFilterVisibleChanged.connect(onFilterVisibleChanged);

  // Public reveal seam for other plugins; an empty path is the workspace-root
  // gesture (the root has no tree row of its own). The tree is movable, so
  // surface whichever sidebar widget holds it.
  const activateTreeHost = (): void => {
    for (const area of ['left', 'right']) {
      for (const widget of app.shell.widgets(area)) {
        if (widget.node.contains(browser.sectionNode)) {
          app.shell.activateById(widget.id);
          return;
        }
      }
    }
    app.shell.activateById(FILE_BROWSER_ID);
  };

  commands.addCommand(CommandIDs.revealPath, {
    label: trans.__('Reveal in File Browser'),
    execute: (args: ReadonlyPartialJSONObject) => {
      const path = (args.path as string | undefined) ?? '';
      activateTreeHost();
      if (path.length === 0) {
        browser.scrollToRoot();
      } else {
        browser.reveal(path);
      }
    }
  });

  commands.addCommand(CommandIDs.revealInFileTree, {
    label: trans.__('Show in File Tree'),
    caption: trans.__('Show this file in the xtralab file browser'),
    isEnabled: args =>
      documentPathToReveal(app, docManager, args.fromTab === true) !==
      undefined,
    execute: args => {
      const path = documentPathToReveal(app, docManager, args.fromTab === true);
      if (path === undefined) {
        return undefined;
      }
      return commands.execute(CommandIDs.revealPath, { path });
    }
  });

  commands.addCommand(CommandIDs.createNewDirectory, {
    label: trans.__('New Folder'),
    caption: trans.__('Create a new folder'),
    icon: newFolderIcon.bindprops({ stylesheet: 'menuItem' }),
    execute: async () => {
      const cwd = getWorkingDirectory(browser);
      try {
        const created = await browser.contentsManager.newUntitled({
          path: cwd,
          type: 'directory'
        });
        browser.notifyPathAdded(toCanonicalPath(created));
      } catch (err) {
        await showErrorMessage(
          trans.__('Could not create folder'),
          err as Error
        );
      }
    }
  });

  commands.addCommand(CommandIDs.newLauncher, {
    label: trans.__('New Launcher'),
    caption: trans.__('Open a new launcher'),
    // Raw `addIcon`, no `menuItem` bindprops: the launcher-extension's blue
    // toolbar-button styling recolors the raw `jp-icon3` paths.
    icon: addIcon,
    execute: () => {
      const cwd = getWorkingDirectory(browser);
      return commands.execute('launcher:create', { cwd });
    }
  });

  browser.selectionChanged.connect(() => {
    for (const id of Object.values(CommandIDs)) {
      commands.notifyCommandChanged(id);
    }
  });

  // `currentChanged` is optional on the shell interface.
  const onCurrentChanged = (): void => {
    commands.notifyCommandChanged(CommandIDs.revealInFileTree);
  };
  app.shell.currentChanged?.connect(onCurrentChanged);

  // The file-tab context-menu entry is declared in `schema/plugin.json`.
  const paletteItem = palette?.addItem({
    command: CommandIDs.revealInFileTree,
    category: trans.__('File Browser')
  });

  // Static context-menu items live in `schema/plugin.json` so users can
  // override them; the schema declares the empty "Open With" placeholder.
  const updateOpenWithMenu = makeOpenWithUpdater(app, browser);
  app.contextMenu.opened.connect(updateOpenWithMenu);

  return () => {
    app.contextMenu.opened.disconnect(updateOpenWithMenu);
    app.shell.currentChanged?.disconnect(onCurrentChanged);
    browser.fileFilterVisibleChanged.disconnect(onFilterVisibleChanged);
    paletteItem?.dispose();
  };
}

/**
 * Toolbar item names, distinct from {@link CommandIDs}: the toolbar API
 * uses opaque names rather than commands.
 */
export namespace ToolbarNames {
  export const newLauncher = 'new-launcher';
  export const newDirectory = 'new-directory';
  export const refresh = 'refresh';
  export const collapseAll = 'collapse-all';
  export const toggleFileFilter = 'toggle-file-filter';
}

/**
 * Populate the toolbar with the buttons that mirror the default JupyterLab
 * file browser.
 */
export function populateToolbar(opts: {
  app: JupyterFrontEnd;
  browser: IXtralabFileBrowser;
}): void {
  const { app, browser } = opts;
  const { commands } = app;

  browser.toolbar.addItem(
    ToolbarNames.newLauncher,
    new CommandToolbarButton({
      commands,
      id: CommandIDs.newLauncher,
      label: ''
    })
  );
  browser.toolbar.addItem(
    ToolbarNames.newDirectory,
    new CommandToolbarButton({
      commands,
      id: CommandIDs.createNewDirectory,
      label: ''
    })
  );
  browser.toolbar.addItem(
    ToolbarNames.refresh,
    new CommandToolbarButton({
      commands,
      id: CommandIDs.refresh,
      label: ''
    })
  );
  browser.toolbar.addItem(
    ToolbarNames.collapseAll,
    new CommandToolbarButton({
      commands,
      id: CommandIDs.collapseAll,
      label: ''
    })
  );
  browser.toolbar.addItem(
    ToolbarNames.toggleFileFilter,
    new CommandToolbarButton({
      commands,
      id: CommandIDs.toggleFileFilter,
      label: ''
    })
  );
}
