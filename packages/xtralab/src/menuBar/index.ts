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
 * Guard after the popup closes: Lumino menus close on a capture-phase document
 * pointerdown, before the button's mousedown, which would instantly reopen.
 */
const REOPEN_GUARD_MS = 250;

/**
 * Collapse the main menu bar into a hamburger button whose popup reuses the
 * live `RankedMenu` instances owned by `MainMenu`. Hiding covers the
 * `jp-menu-panel` container too — its `min-height` would leave an empty strip.
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

    if (!(mainMenu instanceof MainMenu)) {
      return;
    }

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

    mainMenu.hide();
    menuPanel()?.hide();

    let popup: Menu | null = null;
    let popupClosedAt = 0;

    const openMenu = (): void => {
      if (visible) {
        // With the classic bar on screen, act like keyboard menu activation —
        // a popup would compete with the bar for the same Menu instances.
        mainMenu.activeIndex = 0;
        mainMenu.openActiveMenu();
        return;
      }
      if (Date.now() - popupClosedAt < REOPEN_GUARD_MS) {
        return;
      }

      // A plain Menu rebuilt on every open; MenuSvg.insertItem would re-wrap
      // each submenu's renderer per reopen, piling wrappers onto the shared menus.
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
          label: '',
          caption: trans.__('Menu'),
          noFocusOnClick: true,
          'aria-haspopup': 'menu'
        });
        button.id = 'xtralab-main-menu-button';
        button.addClass('jp-xtralab-TopBarButton');
        labShell.add(button, 'top', { rank: 0 });

        const update = (): void => {
          applyVisibility(loaded.get('visible').composite as boolean);
        };
        update();
        loaded.changed.connect(update);
      })
      .catch(reason => {
        // Without settings the collapsed state cannot be managed and the button
        // was never added; reveal the stock bar so menus stay reachable.
        applyVisibility(true);
        console.error(`Failed to load settings for ${PLUGIN_ID}`, reason);
      });
  }
};

export default plugin;
