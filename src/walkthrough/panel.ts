import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { TranslationBundle } from '@jupyterlab/translation';
import { fileIcon } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONValue } from '@lumino/coreutils';
import type { Message } from '@lumino/messaging';
import { Panel, Widget } from '@lumino/widgets';

/**
 * Command the jump links dispatch; keeps the panel decoupled from the plugin.
 */
const HIGHLIGHT_LINES_COMMAND = 'xtralab:highlight-lines';

/**
 * A rich visual embedded in a step (rendered through the rendermime registry).
 */
export interface IWalkthroughMedia {
  mimeType: string;
  data: ReadonlyPartialJSONValue;
}

/**
 * One step of a walkthrough. Every field is optional, but a step needs at least one.
 */
export interface IWalkthroughStep {
  title?: string;
  body?: string;
  media?: IWalkthroughMedia;
  path?: string;
  line?: number;
  endLine?: number;
}

export namespace WalkthroughPanel {
  export interface IOptions {
    rendermime: IRenderMimeRegistry;
    commands: CommandRegistry;
    trans: TranslationBundle;
  }
}

/**
 * A read-only, scrollable column of walkthrough steps for the side area.
 *
 * The agent appends steps as it narrates, so the explanation lives beside the
 * code the user is looking at and persists for them to read at their own pace,
 * rather than scrolling away in the chat. Each step renders Markdown (with code
 * snippets, Mermaid, math), can embed a rich visual, and can offer a button
 * that opens the referenced file and highlights its lines.
 */
export class WalkthroughPanel extends Panel {
  constructor(options: WalkthroughPanel.IOptions) {
    super();
    this._rendermime = options.rendermime;
    this._commands = options.commands;
    this._trans = options.trans;
    this.addClass('jp-xtralab-Walkthrough');
  }

  /**
   * Remove every step, leaving an empty panel.
   */
  clear(): void {
    while (this.widgets.length > 0) {
      this.widgets[0].dispose();
    }
  }

  /**
   * Dispose on close (e.g. the close button when the panel has been dragged to
   * the main area) rather than leaving a detached, reusable widget behind. The
   * next `xtralab:walkthrough` call recreates the panel in the side area.
   */
  protected onCloseRequest(msg: Message): void {
    super.onCloseRequest(msg);
    this.dispose();
  }

  /**
   * Append a step and scroll it into view.
   */
  async addStep(step: IWalkthroughStep): Promise<void> {
    const card = new Panel();
    card.addClass('jp-xtralab-Walkthrough-step');
    this.addWidget(card);

    if (step.title) {
      const heading = new Widget({ node: document.createElement('h3') });
      heading.addClass('jp-xtralab-Walkthrough-stepTitle');
      heading.node.textContent = step.title;
      card.addWidget(heading);
    }

    if (step.body) {
      await this._render(card, 'text/markdown', step.body);
    }

    if (step.media && typeof step.media.mimeType === 'string') {
      await this._render(card, step.media.mimeType, step.media.data);
    }

    if (step.path) {
      card.addWidget(this._jumpButton(step.path, step.line, step.endLine));
    }

    // Bring the newest step into view.
    this.node.scrollTop = this.node.scrollHeight;
  }

  private async _render(
    parent: Panel,
    mimeType: string,
    data: ReadonlyPartialJSONValue
  ): Promise<void> {
    const bundle = { [mimeType]: data };
    const chosen = this._rendermime.preferredMimeType(bundle, 'any');
    if (!chosen) {
      return;
    }
    const renderer = this._rendermime.createRenderer(chosen);
    renderer.addClass('jp-xtralab-Walkthrough-content');
    parent.addWidget(renderer);
    await renderer.renderModel(
      this._rendermime.createModel({ data: bundle, trusted: true })
    );
  }

  private _jumpButton(path: string, line?: number, endLine?: number): Widget {
    const node = document.createElement('div');
    node.className = 'jp-xtralab-Walkthrough-jumpRow';
    const where = line ? `${path}:${line}` : path;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jp-xtralab-Walkthrough-jump';
    button.title = this._trans.__('Open %1 in the editor', where);

    const icon = fileIcon.element({
      tag: 'span',
      className: 'jp-xtralab-Walkthrough-jumpIcon'
    });
    const label = document.createElement('span');
    label.className = 'jp-xtralab-Walkthrough-jumpLabel';
    label.textContent = where;
    button.appendChild(icon);
    button.appendChild(label);
    node.appendChild(button);

    button.addEventListener('click', () => {
      void this._commands.execute(HIGHLIGHT_LINES_COMMAND, {
        path,
        line,
        endLine
      });
    });
    return new Widget({ node });
  }

  private _rendermime: IRenderMimeRegistry;
  private _commands: CommandRegistry;
  private _trans: TranslationBundle;
}
