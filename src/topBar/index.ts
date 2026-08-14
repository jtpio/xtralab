import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { CommandToolbarButton, LabIcon } from '@jupyterlab/ui-components';

import { leftSidebarIcon, rightSidebarIcon } from './icons';

const PLUGIN_ID = 'xtralab:top-bar';

/**
 * Upstream commands that collapse or expand the side areas; binding to them
 * keeps behavior and `isToggled`/`isEnabled` in lockstep with the View menu.
 */
const TOGGLE_LEFT_AREA = 'application:toggle-left-area';
const TOGGLE_RIGHT_AREA = 'application:toggle-right-area';

interface IButtonSpec {
  /**
   * Stable widget id (required by `LabShell.add`).
   */
  id: string;
  /**
   * Command the button triggers and mirrors the state of.
   */
  command: string;
  icon: LabIcon;
  caption: (trans: ReturnType<ITranslator['load']>) => string;
  /**
   * Rank in the `top` area: the menu bar sits at 100 and the rank-0 upstream
   * logo is disabled; `margin-left: auto` (topBar.css) floats the right button.
   */
  rank: number;
  /**
   * Side-specific class, used by the stylesheet for placement.
   */
  sideClass: string;
}

const BUTTONS: IButtonSpec[] = [
  {
    id: 'xtralab-toggle-left-sidebar',
    command: TOGGLE_LEFT_AREA,
    icon: leftSidebarIcon,
    caption: trans => trans.__('Toggle left sidebar'),
    rank: -1,
    sideClass: 'jp-xtralab-TopBarButton-left'
  },
  {
    id: 'xtralab-toggle-right-sidebar',
    command: TOGGLE_RIGHT_AREA,
    icon: rightSidebarIcon,
    caption: trans => trans.__('Toggle right sidebar'),
    rank: 1000,
    sideClass: 'jp-xtralab-TopBarButton-right'
  }
];

/**
 * Add macOS-style sidebar toggle buttons to the top bar: left at the leading
 * edge, right at the far edge. Each wraps the upstream toggle command and
 * reflects its state — pressed while the sidebar is open, disabled while the
 * area is empty (as the right area is by default).
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Add left and right sidebar toggle buttons to the top bar.',
  autoStart: true,
  requires: [ILabShell],
  optional: [ITranslator],
  activate: (
    app: JupyterFrontEnd,
    labShell: ILabShell,
    translator: ITranslator | null
  ): void => {
    const { commands } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // The upstream toggle commands don't fire `commandChanged` on layout
    // shifts, and `CommandToolbarButton` only re-renders on that signal.
    labShell.layoutModified.connect(() => {
      for (const spec of BUTTONS) {
        commands.notifyCommandChanged(spec.command);
      }
    });

    // Defer to `app.restored`: `CommandToolbarButton` renders nothing until
    // its command exists and doesn't re-render on the `added` change type.
    void app.restored.then(() => {
      for (const spec of BUTTONS) {
        const button = new CommandToolbarButton({
          commands,
          id: spec.command,
          icon: spec.icon,
          // Empty label keeps the button icon-only.
          label: '',
          caption: spec.caption(trans),
          // ToolbarButtonComponent otherwise focuses the button on click,
          // leaving a stray focus fill on this title-bar control; Tab still works.
          noFocusOnClick: true
        });
        button.id = spec.id;
        button.addClass('jp-xtralab-TopBarButton');
        button.addClass(spec.sideClass);
        labShell.add(button, 'top', { rank: spec.rank });
      }
    });
  }
};

export default plugin;
