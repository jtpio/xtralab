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

/**
 * Factory name of JupyterLab's settings-driven top bar toolbar (`#jp-top-bar`,
 * built by `@jupyterlab/application-extension:top-bar`).
 */
const TOPBAR_FACTORY = 'TopBar';

/**
 * Name of the pill item within that toolbar. Its placement is declared under
 * `jupyter.lab.toolbars` in this plugin's settings schema
 * (schema/command-bar.json): the core toolbar ships a spacer at rank 50, so
 * the pill's higher rank lands it at the trailing end of the toolbar, next to
 * the right-sidebar toggle button.
 */
const ITEM_NAME = 'omnibox';

/**
 * A search-bar-styled launcher pill. It holds no text input of its own:
 * clicking it (or pressing Enter/Space while it is focused) runs `onActivate`,
 * which opens the omnibox.
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
    // The click bubbles from the inner pill button up to the root node
    // listened on here; keyboard Enter/Space on the focused button raises the
    // same synthetic click.
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
    /**
     * Runs on click or keyboard activation.
     */
    onActivate: () => void;
  }

  export function createNode(
    label: string,
    caption: string,
    shortcut?: string
  ): HTMLElement {
    // The root is a plain wrapper: as a toolbar item it receives the core
    // `.jp-Toolbar > .jp-Toolbar-item` sizing (full height, centered flex),
    // which would otherwise stretch the pill itself; the button inside keeps
    // its own compact pill height.
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
 * Contribute a search-bar-styled command bar to JupyterLab's top bar toolbar.
 * Clicking it opens the omnibox — a launcher overlay that fuzzy-searches files
 * and commands and routes a typed prompt to an agent.
 *
 * The pill is a regular settings-driven toolbar item: this plugin registers a
 * widget factory for it on the `IToolbarWidgetRegistry` and declares its rank
 * in schema/command-bar.json, so users can move or disable it from the Top
 * Bar settings like any other toolbar item.
 *
 * The factory is only registered when the omnibox is available — the
 * `IOmnibox` token is provided by `xtralab:omnibox` — so the pill never
 * appears with nothing to open (without a factory, the toolbar item resolves
 * to an empty command button that renders nothing).
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
      // Show the omnibox's keyboard shortcut as a hint in the pill, derived
      // from the live binding (registered by xtralab:omnibox, which activates
      // first as the IOmnibox provider) so it stays correct and uses the
      // platform's modifier symbols. Empty when no binding is registered.
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
