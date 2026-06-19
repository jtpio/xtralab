import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { searchIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';

import { IOmnibox, OMNIBOX_OPEN_COMMAND } from '../omnibox/tokens';

const PLUGIN_ID = 'xtralab:command-bar';

/**
 * A search-bar-styled launcher for the `top` area. It holds no text input of
 * its own: clicking the pill (or pressing Enter/Space while it is focused)
 * runs `onActivate`, which opens the omnibox.
 *
 * The widget's root is a transparent, full-height wrapper centered as an
 * overlay over the whole top panel (style/commandBar.css). The wrapper
 * ignores pointer events so only the inner pill is clickable and the empty
 * strips above and below it let clicks fall through to whatever sits beneath
 * the overlay, such as the menu bar.
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
    this.addClass('xtralab-CommandBar');
    this._onActivate = options.onActivate;
  }

  handleEvent(event: Event): void {
    if (event.type === 'click') {
      this._onActivate();
    }
  }

  protected onAfterAttach(): void {
    // The pill restores `pointer-events: auto`, so the click bubbles from it
    // up to the root node listened on here; keyboard Enter/Space on the
    // focused button raises the same synthetic click.
    this.node.addEventListener('click', this);
  }

  protected onBeforeDetach(): void {
    this.node.removeEventListener('click', this);
  }

  private _onActivate: () => void;
}

namespace CommandBar {
  export interface IOptions {
    /** Placeholder-style text shown inside the pill. */
    label: string;
    /** Tooltip and accessible name for the button. */
    caption: string;
    /** Formatted keyboard shortcut shown as a trailing hint, if any. */
    shortcut?: string;
    /** Runs on click or keyboard activation. */
    onActivate: () => void;
  }

  export function createNode(
    label: string,
    caption: string,
    shortcut?: string
  ): HTMLElement {
    const wrapper = document.createElement('div');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'xtralab-CommandBar-button';
    button.title = caption;
    button.setAttribute('aria-label', caption);

    const icon = searchIcon.element({
      tag: 'span',
      className: 'xtralab-CommandBar-icon'
    });

    const text = document.createElement('span');
    text.className = 'xtralab-CommandBar-label';
    text.textContent = label;

    button.appendChild(icon);
    button.appendChild(text);

    if (shortcut) {
      const hint = document.createElement('span');
      hint.className = 'xtralab-CommandBar-shortcut';
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
 * Add a centered, search-bar-styled command bar to the top area. Clicking it
 * opens the omnibox — a launcher overlay that fuzzy-searches files and
 * commands and routes a typed prompt to an agent (the leading sidebar toggle
 * and the menu bar sit to its left, the trailing sidebar toggle to its right;
 * the bar is centered over the whole panel as an overlay, so it stays put
 * regardless of their widths).
 *
 * The bar is only added when the omnibox is available — the `IOmnibox` token
 * is provided by `xtralab:omnibox` — so it never appears with nothing to open.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Add a centered command bar to the top area that opens the omnibox.',
  autoStart: true,
  requires: [ILabShell],
  optional: [IOmnibox, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    labShell: ILabShell,
    omnibox: IOmnibox | null,
    translator: ITranslator | null
  ): void => {
    if (!omnibox) {
      return;
    }

    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // Show the omnibox's keyboard shortcut as a hint in the pill, derived from
    // the live binding (registered by xtralab:omnibox, which activates first as
    // the IOmnibox provider) so it stays correct and uses the platform's
    // modifier symbols. Empty when no binding is registered.
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

    labShell.add(widget, 'top', { rank: 500 });
  }
};

export default plugin;
