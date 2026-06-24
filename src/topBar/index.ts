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
 * Upstream commands from `@jupyterlab/application-extension` that collapse or
 * expand the side areas. We bind the buttons to these rather than
 * reimplementing the toggle, so behavior (and the `isToggled`/`isEnabled`
 * state the buttons reflect) stays in lockstep with the View menu entries
 * and their keyboard shortcuts.
 */
const TOGGLE_LEFT_AREA = 'application:toggle-left-area';
const TOGGLE_RIGHT_AREA = 'application:toggle-right-area';

interface IButtonSpec {
  /** Stable widget id (required by `LabShell.add`). */
  id: string;
  /** Command the button triggers and mirrors the state of. */
  command: string;
  icon: LabIcon;
  caption: (trans: ReturnType<ITranslator['load']>) => string;
  /**
   * Rank within the `top` area. The main menu bar is added at rank 100, so a
   * negative rank lands the left button at the leading edge before it; a large
   * rank puts the right button after the menu, where `margin-left: auto`
   * (style/topBar.css) floats it to the far edge. xtralab's shipped config
   * disables the upstream Jupyter logo that otherwise occupies rank 0, so the
   * leading edge is free.
   */
  rank: number;
  /** Side-specific class, used by the stylesheet for placement. */
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
 * Add two icon buttons to the top bar that toggle the left and right side
 * areas, mirroring the macOS-style sidebar buttons: a left-sidebar button at
 * the leading edge and a right-sidebar button at the far edge.
 *
 * Each is a `CommandToolbarButton` wrapping an existing
 * `application:toggle-{left,right}-area` command, so clicking it runs the
 * same toggle as the View menu and the button reflects the command's state —
 * pressed while the matching sidebar is open, and disabled when the area is
 * empty. Note xtralab ships nothing in the right area by default (the
 * property inspector, table of contents and debugger are all disabled), so
 * the right button stays disabled until a widget is moved or added there.
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

    // The upstream toggle-{left,right}-area commands derive `isEnabled` from
    // `!labShell.isEmpty(side)` but don't fire `commandChanged` when widgets
    // move in or out of a side area. `CommandToolbarButton` only re-renders on
    // `commandChanged` for its own id, so the buttons need an explicit notify
    // whenever the shell layout shifts — `layoutModified` covers each side
    // handler's `_updated` (add/remove, expand/collapse), keeping both
    // `isEnabled` and `isToggled` in sync.
    labShell.layoutModified.connect(() => {
      for (const spec of BUTTONS) {
        commands.notifyCommandChanged(spec.command);
      }
    });

    // Defer to `app.restored` so the upstream toggle commands are already in
    // the registry: `CommandToolbarButton` renders nothing until its command
    // exists and only re-renders on `commandChanged` of type `changed` /
    // `many-changed` (not `added`), so mounting earlier could leave a button
    // blank until the next unrelated command change.
    void app.restored.then(() => {
      for (const spec of BUTTONS) {
        const button = new CommandToolbarButton({
          commands,
          id: spec.command,
          icon: spec.icon,
          // Empty label keeps the button icon-only: the override is forwarded
          // verbatim and the component skips the label span when it is falsy.
          label: '',
          caption: spec.caption(trans),
          // Toggle on mousedown without focusing the button. Otherwise
          // ToolbarButtonComponent calls `event.target.focus()` on click,
          // leaving the stealth button showing a focus fill/outline (the
          // stray "border") until you click elsewhere — unwanted chrome for a
          // title-bar control. Keyboard Tab focus still works, so this stays
          // accessible.
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
