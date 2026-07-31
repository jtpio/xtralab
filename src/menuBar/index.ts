import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { IMainMenu, MainMenu } from '@jupyterlab/mainmenu';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { CommandToolbarButton, MenuSvg } from '@jupyterlab/ui-components';
import { Menu, Widget } from '@lumino/widgets';

import { mainMenuIcon } from './icons';

const PLUGIN_ID = 'xtralab:menu-bar';

const OPEN_COMMAND = 'xtralab:open-main-menu';
const TOGGLE_COMMAND = 'xtralab:toggle-menu-bar';

/**
 * How long after the popup closes a button press still counts as "close
 * only". An open Lumino menu closes itself on any outside press from a
 * document `pointerdown` listener in the capture phase, which runs before
 * the button's own mousedown handler — so without this window, pressing the
 * button while the popup is open would close it and instantly reopen it.
 */
const REOPEN_GUARD_MS = 250;

/**
 * Collapse the main menu bar into a compact menu button.
 *
 * By default the File/Edit/View/… menu bar is hidden and a single hamburger
 * button at the leading edge of the top bar opens the same menus as a
 * vertical popup with submenu flyouts (the VS Code hidden-menu-bar pattern).
 * The popup reuses the live `RankedMenu` instances owned by the `MainMenu` —
 * the same mechanism `MenuBar` itself uses to host them — so ranks,
 * separators, toggle states, and menus added or removed at runtime
 * (jupyterlab-git's Git menu, the Run/Kernel toggling in `xtralab:menus`)
 * are all reflected without any duplication.
 *
 * Hiding covers both the bar and its `jp-menu-panel` container: the panel
 * carries its own 27px `min-height`, so hiding only the bar would leave an
 * empty strip across the window. A persisted "Show Menu Bar" toggle
 * (View → Appearance, also in the command palette) restores the classic
 * always-on bar, mirroring the statusbar-extension pattern.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Collapse the main menu bar into a compact menu button.',
  autoStart: true,
  requires: [IMainMenu, ILabShell, ISettingRegistry],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    mainMenu: IMainMenu,
    labShell: ILabShell,
    settingRegistry: ISettingRegistry,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): void => {
    const { commands } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // The IMainMenu token resolves to the MainMenu MenuBar widget in
    // JupyterLab core, and @jupyterlab/mainmenu is a deduplicated singleton
    // so `instanceof` is reliable. Bail if a substitute provider ever
    // supplies a non-widget implementation — there is nothing to hide then.
    if (!(mainMenu instanceof MainMenu)) {
      return;
    }

    /**
     * The menu bar's host panel (`jp-menu-panel`). Preferred via `parent`
     * once the bar is attached — also correct in single-document mode, where
     * LabShell reparents the panel out of the top area. Before the deferred
     * attach, fall back to scanning the top area, where LabShell inserts the
     * panel at construction time.
     */
    const menuPanel = (): Widget | null =>
      mainMenu.parent ??
      Array.from(labShell.widgets('top')).find(w => w.id === 'jp-menu-panel') ??
      null;

    let visible = false;
    let button: CommandToolbarButton | null = null;
    let settings: ISettingRegistry.ISettings | null = null;

    const applyVisibility = (value: boolean): void => {
      visible = value;
      mainMenu.setHidden(!value);
      menuPanel()?.setHidden(!value);
      button?.setHidden(value);
      commands.notifyCommandChanged(TOGGLE_COMMAND);
    };

    // Hide before first paint: the shipped default is collapsed and settings
    // resolve asynchronously, so waiting for them would flash the empty
    // menu-panel strip during startup. For users who opted into the visible
    // bar it appears at layout restore — the moment it appears anyway,
    // because the mainmenu-extension's shell.add is deferred until then.
    mainMenu.hide();
    menuPanel()?.hide();

    let popup: Menu | null = null;
    let popupClosedAt = 0;

    const openMenu = (): void => {
      if (visible) {
        // The classic bar is on screen; behave like keyboard menu
        // activation instead of opening a redundant popup that would
        // compete with the bar for the same Menu instances.
        mainMenu.activeIndex = 0;
        mainMenu.openActiveMenu();
        return;
      }
      if (Date.now() - popupClosedAt < REOPEN_GUARD_MS) {
        return;
      }

      // One popup instance, rebuilt from the bar's current menus on every
      // open so runtime menu changes stay reflected. It is a plain Lumino
      // Menu rather than a MenuSvg: MenuSvg.insertItem re-wraps each
      // submenu's renderer and insertItem on every call, which would pile
      // wrappers onto the shared menus across reopens. The svg renderer and
      // themed-container class are applied directly instead, matching how
      // the real menus are constructed in MainMenu.
      if (popup === null) {
        popup = new Menu({ commands, renderer: MenuSvg.defaultRenderer });
        popup.addClass('jp-ThemedContainer');
        popup.addClass('jp-xtralab-MainMenuPopup');
        popup.aboutToClose.connect(() => {
          popupClosedAt = Date.now();
        });
      } else {
        popup.clearItems();
      }

      // Skip empty menus: MenuBar disables their headings, but submenu items
      // have no such affordance and would open a blank panel.
      for (const menu of mainMenu.menus) {
        if (menu.items.length > 0) {
          popup.addItem({ type: 'submenu', submenu: menu });
        }
      }

      const anchor = button?.node.getBoundingClientRect();
      // The 3px gap matches the detached-dropdown offset chrome.css gives
      // the real menu bar's dropdowns (.lm-Menu.lm-MenuBar-menu).
      popup.open(anchor?.left ?? 0, (anchor?.bottom ?? 0) + 3);
    };

    commands.addCommand(OPEN_COMMAND, {
      label: trans.__('Open Menu'),
      caption: trans.__('Open the main menu'),
      icon: mainMenuIcon,
      execute: openMenu
    });

    commands.addCommand(TOGGLE_COMMAND, {
      label: trans.__('Show Menu Bar'),
      caption: trans.__('Toggle the visibility of the main menu bar'),
      isToggled: () => visible,
      execute: async () => {
        // Apply immediately so the toggle feels instant, then persist; the
        // settings `changed` signal re-applies the same state (idempotent).
        // A failed write still leaves the in-memory toggle working for the
        // current session.
        applyVisibility(!visible);
        if (settings !== null) {
          try {
            await settings.set('visible', visible);
          } catch (reason) {
            console.error(
              'xtralab: failed to persist menu bar visibility',
              reason
            );
          }
        }
      }
    });

    if (palette) {
      const category = trans.__('Other');
      palette.addItem({ command: OPEN_COMMAND, category });
      palette.addItem({ command: TOGGLE_COMMAND, category });
    }

    Promise.all([settingRegistry.load(PLUGIN_ID), app.restored])
      .then(([loaded]) => {
        settings = loaded;

        button = new CommandToolbarButton({
          commands,
          id: OPEN_COMMAND,
          icon: mainMenuIcon,
          // Empty label keeps the button icon-only: the override is
          // forwarded verbatim and the component skips the label span when
          // it is falsy.
          label: '',
          caption: trans.__('Menu'),
          // Trigger on mousedown without focusing, like the sidebar
          // toggles — and a prerequisite for the reopen guard: mousedown
          // fires in the same interaction as the popup's capture-phase
          // close, so the guard window is measured press-to-press rather
          // than press-to-release.
          noFocusOnClick: true,
          'aria-haspopup': 'menu'
        });
        button.id = 'xtralab-main-menu-button';
        button.addClass('jp-xtralab-TopBarButton');
        // Rank 0 slots the button between the left sidebar toggle (-1) and
        // the menu panel (100), in the slot freed by the disabled upstream
        // logo plugin.
        labShell.add(button, 'top', { rank: 0 });

        const update = (): void => {
          applyVisibility(loaded.get('visible').composite as boolean);
        };
        update();
        loaded.changed.connect(update);
      })
      .catch(reason => {
        // Without settings the collapsed state cannot be managed (and the
        // button was never added) — reveal the stock bar rather than leave
        // the app with no reachable menus.
        applyVisibility(true);
        console.error(`Failed to load settings for ${PLUGIN_ID}`, reason);
      });
  }
};

export default plugin;
