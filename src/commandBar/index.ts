import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IToolbarWidgetRegistry } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { searchIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';

import { IOmnibox, OMNIBOX_OPEN_COMMAND } from '../omnibox/tokens';

const PLUGIN_ID = 'xtralab:command-bar';

/** Factory name of JupyterLab's settings-driven top bar toolbar (`#jp-top-bar`). */
const TOPBAR_FACTORY = 'TopBar';

/**
 * Name of the pill item within that toolbar; its rank in schema/command-bar.json
 * places it after the core spacer (rank 50), at the trailing end.
 */
const ITEM_NAME = 'omnibox';

/**
 * A search-bar-styled launcher pill with no input of its own: activating it
 * runs `onActivate`, which opens the omnibox.
 */
class CommandBar extends Widget {
  constructor(options: CommandBar.IOptions) {
    super({
      node: CommandBar.createNode(
        options.label,
        options.caption,
        options.shortcut
      )
    });
    this.addClass('jp-xtralab-CommandBar');
    this._onActivate = options.onActivate;
  }

  handleEvent(event: Event): void {
    if (event.type === 'click') {
      this._onActivate();
    }
  }

  protected onAfterAttach(): void {
    // Keyboard Enter/Space on the focused button raises the same synthetic click.
    this.node.addEventListener('click', this);
  }

  protected onBeforeDetach(): void {
    this.node.removeEventListener('click', this);
  }

  private _onActivate: () => void;
}

namespace CommandBar {
  export interface IOptions {
    /**
     * Placeholder-style text shown inside the pill.
     */
    label: string;
    /**
     * Tooltip and accessible name for the button.
     */
    caption: string;
    /**
     * Formatted keyboard shortcut shown as a trailing hint, if any.
     */
    shortcut?: string;
    onActivate: () => void;
  }

  export function createNode(
    label: string,
    caption: string,
    shortcut?: string
  ): HTMLElement {
    // Plain wrapper: the core `.jp-Toolbar-item` sizing would otherwise
    // stretch the pill itself.
    const wrapper = document.createElement('div');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jp-xtralab-CommandBar-button';
    button.title = caption;
    button.setAttribute('aria-label', caption);

    const icon = searchIcon.element({
      tag: 'span',
      className: 'jp-xtralab-CommandBar-icon'
    });

    const text = document.createElement('span');
    text.className = 'jp-xtralab-CommandBar-label';
    text.textContent = label;

    button.appendChild(icon);
    button.appendChild(text);

    if (shortcut) {
      const hint = document.createElement('span');
      hint.className = 'jp-xtralab-CommandBar-shortcut';
      hint.textContent = shortcut;
      // Decorative: the button's aria-label already names the action.
      hint.setAttribute('aria-hidden', 'true');
      button.appendChild(hint);
    }

    wrapper.appendChild(button);
    return wrapper;
  }
}

/**
 * Contribute a search-bar-styled pill to the top bar toolbar that opens the
 * omnibox. It is a settings-driven toolbar item (factory here, rank in
 * schema/command-bar.json) registered only when `IOmnibox` is provided —
 * without a factory the item resolves to an empty button that renders nothing.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Add a command bar to the top bar toolbar that opens the omnibox.',
  autoStart: true,
  requires: [IToolbarWidgetRegistry],
  optional: [IOmnibox, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    toolbarRegistry: IToolbarWidgetRegistry,
    omnibox: IOmnibox | null,
    translator: ITranslator | null
  ): void => {
    if (!omnibox) {
      return;
    }

    const trans = (translator ?? nullTranslator).load('jupyterlab');

    toolbarRegistry.addFactory(TOPBAR_FACTORY, ITEM_NAME, () => {
      // Derive the shortcut hint from the live binding (xtralab:omnibox
      // activates first as the IOmnibox provider); empty when none exists.
      const binding = app.commands.keyBindings.find(
        keyBinding => keyBinding.command === OMNIBOX_OPEN_COMMAND
      );
      const shortcut = binding
        ? CommandRegistry.formatKeystroke(binding.keys)
        : '';

      const widget = new CommandBar({
        label: trans.__('Search…'),
        caption: trans.__('Search files and commands, or ask an agent'),
        shortcut,
        onActivate: () => {
          omnibox.open();
        }
      });
      widget.id = 'xtralab-command-bar';
      return widget;
    });
  }
};

export default plugin;
