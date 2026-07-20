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
 * Command identifiers exposed by the xtralab browser. We deliberately namespace
 * these under `xtralab:` rather than reusing the `filebrowser:` ids
 * because the core `filebrowser:*` commands look up a `FileBrowser` instance
 * via `IFileBrowserFactory.tracker` — our widget is not a `FileBrowser`, so
 * those handlers would never see it.
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
  export const createNewDirectory = 'xtralab:create-new-directory';
  export const newLauncher = 'xtralab:new-launcher';
  export const revealPath = 'xtralab:reveal-path';
  export const revealInFileTree = 'xtralab:reveal-in-file-tree';
}

/**
 * Submenu id used to host the dynamically populated "Open With" entries.
 * Distinct from the core file browser's `jp-contextmenu-open-with` so the
 * core's populator does not try to fill ours with items derived from the
 * default file browser's selection.
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
 * Resolve the path of the item the user right-clicked. We prefer the
 * contextmenu event's target — that is how `app.contextMenu` resolves which
 * items match a selector — and fall back to the first item in the tree's
 * selection if the command was invoked without an active contextmenu event
 * (e.g. from the command palette).
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
 * Resolve the kind of the item that was right-clicked, based on the data
 * attributes emitted by `@pierre/trees` rows. Returns `undefined` if no
 * contextmenu event is active or the target is not a tree item.
 */
function getTargetKind(app: JupyterFrontEnd): 'file' | 'folder' | undefined {
  const node = app.contextMenuHitTest(
    n => n.dataset !== undefined && n.dataset.type === 'item'
  );
  const kind = node?.dataset.itemType;
  return kind === 'file' || kind === 'folder' ? kind : undefined;
}

/**
 * Resolve the canonical paths the "Open" command should act on. When the
 * user right-clicks a row that is part of the current selection, every
 * selected file is opened — matching the default file browser, where
 * "Open" on any file in a multi-selection opens them all. If the
 * right-clicked row is *not* in the selection, only that row is opened.
 *
 * Folders are always filtered out: there is no "current directory" in
 * this tree, so opening a folder via "Open" is a no-op.
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
 * Resolve the directory used as the working directory for actions that
 * create a new file or folder. Folder selections become their own cwd;
 * file selections fall back to their parent. Returns the empty string
 * when the tree has no selection — that matches the contents API's
 * convention for "the root directory".
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
 * Resolve the main-area widget whose tab is the target of the current
 * context-menu event, or `null` when that target is not a document tab. The
 * shell stamps each tab's `data-id` with its widget id, so the right-clicked
 * tab resolves even when it is not the current one.
 *
 * Valid only during a context-menu invocation: `contextMenuHitTest` reads the
 * last context-menu event, which is not cleared when the menu closes, so
 * {@link documentPathToReveal} gates this to avoid resolving a stale tab.
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
 * Resolve the document to reveal as a canonical `@pierre/trees` path: the
 * right-clicked tab when `fromContextMenu` is true (the file-tab menu),
 * otherwise the active main-area widget (the palette). A file's context
 * `path` is already canonical. Returns `undefined` when nothing resolves.
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
 * Refresh the "Open With" submenu's items from the document factories that
 * can open the file under the right-click. Mirrors the
 * `@jupyterlab/filebrowser-extension:open-with` pattern: the schema declares
 * an empty submenu by id, and we look it up on the open context menu and
 * fill it before the user can hover.
 *
 * `preferredWidgetFactories(path)` is path-only, so the populator stays
 * synchronous and the submenu is ready before the user can hover over it.
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
 * Register every xtralab command on the application command registry, attach
 * the items to the application context menu, and wire up the dynamic
 * "Open With" submenu populator.
 *
 * @returns A function that detaches the menu items and signal listener.
 *   The commands themselves are owned by the registry for the lifetime of
 *   the plugin.
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

  // Public reveal seam. Other plugins (editor breadcrumbs, future
  // "reveal in tree" actions) call this command rather than depending
  // on the file browser widget directly. Activating the sidebar is part
  // of the contract: the tree is hidden behind a tab and a reveal that
  // does not surface the panel would silently no-op from the user's
  // point of view. An empty path is the "workspace root" gesture —
  // there is no tree row for the root itself, so the browser is asked
  // to scroll back to the top and clear its selection instead.
  commands.addCommand(CommandIDs.revealPath, {
    label: trans.__('Reveal in File Browser'),
    execute: (args: ReadonlyPartialJSONObject) => {
      const path = (args.path as string | undefined) ?? '';
      app.shell.activateById(FILE_BROWSER_ID);
      if (path.length === 0) {
        browser.scrollToRoot();
      } else {
        browser.reveal(path);
      }
    }
  });

  // Reveal the resolved document in the tree browser via the reveal-path
  // command, which surfaces the sidebar and scrolls to the target.
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
    // Skip the `menuItem` bindprops the other commands use: this command
    // lives on the toolbar, where the launcher-extension's blue button
    // styling expects the raw `jp-icon3` paths from `addIcon` so it can
    // recolor them against the brand background.
    icon: addIcon,
    execute: () => {
      const cwd = getWorkingDirectory(browser);
      return commands.execute('launcher:create', { cwd });
    }
  });

  // Re-evaluate enabled/visible state when the user changes the tree
  // selection, in case a command's predicate depends on the selection.
  browser.selectionChanged.connect(() => {
    for (const id of Object.values(CommandIDs)) {
      commands.notifyCommandChanged(id);
    }
  });

  // This command's enabled state tracks the active widget, not the tree
  // selection, so re-evaluate it on current-widget changes. `currentChanged`
  // is optional on the shell interface.
  const onCurrentChanged = (): void => {
    commands.notifyCommandChanged(CommandIDs.revealInFileTree);
  };
  app.shell.currentChanged?.connect(onCurrentChanged);

  // Also surface it in the palette (acts on the active editor); the file-tab
  // context-menu entry is declared in `schema/plugin.json`.
  const paletteItem = palette?.addItem({
    command: CommandIDs.revealInFileTree,
    category: trans.__('File Browser')
  });

  // The static items are declared in `schema/plugin.json` under
  // `jupyter.lab.menus.context` so users can override or disable them. The
  // schema also declares an empty submenu placeholder with id
  // `OPEN_WITH_SUBMENU_ID`; we fill it on every open from the document
  // factories that can open the right-clicked file.
  const updateOpenWithMenu = makeOpenWithUpdater(app, browser);
  app.contextMenu.opened.connect(updateOpenWithMenu);

  return () => {
    app.contextMenu.opened.disconnect(updateOpenWithMenu);
    app.shell.currentChanged?.disconnect(onCurrentChanged);
    paletteItem?.dispose();
  };
}

/**
 * The names we register with the toolbar. Kept distinct from
 * {@link CommandIDs} because the toolbar API uses opaque names rather
 * than commands.
 */
export namespace ToolbarNames {
  export const newLauncher = 'new-launcher';
  export const newDirectory = 'new-directory';
  export const refresh = 'refresh';
  export const collapseAll = 'collapse-all';
}

/**
 * Populate the file browser's toolbar with the buttons that mirror the
 * default JupyterLab file browser: a "+" launcher button, a new-folder
 * button, and a refresh button. Returns a list of button names so callers
 * can extend it or remove items if they need to.
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
}
