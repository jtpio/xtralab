import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, Notification } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';

import type { IAgent } from '../launcher/agents';
import { agentCommandId, IAgentRegistry } from '../launcher/tokens';

import {
  domSelectionInView,
  editorAskRequest,
  resolveEditorTarget
} from './editorSelection';
import { askAgentIcon } from './icons';
import { AskAgentPopup } from './popup';
import { buildPrompt } from './prompt';
import { ASK_AGENT_COMMAND, IAskAgent, IAskAgentRequest } from './tokens';

const PLUGIN_ID = 'xtralab:ask-agent';

/** `localStorage` key remembering the last agent picked in the popup. */
const LAST_AGENT_STORAGE_KEY = 'xtralab:ask-agent:agent';

/**
 * Delay between a selection change and showing the pill, so the affordance
 * appears once the selection settles rather than flickering along a drag.
 */
const SELECTION_SETTLE_MS = 250;

/**
 * Keystroke that opens the popup in a file editor. `Accel I` would be the
 * familiar "inline chat" chord but CodeMirror's default keymap owns `Mod-i`
 * (selectParentSyntax) inside editors and prevents-default before Lumino
 * sees it; `Accel .` — the "quick fix" chord elsewhere — is free in the
 * editor, the browser and JupyterLab.
 */
const ASK_AGENT_KEYS = 'Accel .';

/** Gap between the pill and the selection anchor, in pixels. */
const PILL_GAP = 6;

/** Minimum distance kept between the pill and the viewport edges. */
const PILL_VIEWPORT_MARGIN = 8;

function readLastAgentId(): string | null {
  try {
    return window.localStorage.getItem(LAST_AGENT_STORAGE_KEY);
  } catch {
    // localStorage may throw in privacy mode or sandboxed contexts; the
    // popup then just defaults to the first agent.
    return null;
  }
}

function writeLastAgentId(agentId: string): void {
  try {
    window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, agentId);
  } catch {
    // See readLastAgentId — best-effort persistence.
  }
}

/**
 * Select code in a file editor (or pick diff lines) and prompt a coding
 * agent about it.
 *
 * The plugin watches the document selection: a non-empty selection inside a
 * CodeMirror file editor or notebook cell grows a small floating "Ask agent"
 * pill next to the selection. Clicking it (or running `xtralab:ask-agent`,
 * bound to Accel+. in editors and notebooks) opens a popup where the user
 * types an instruction and picks one of the launcher's agents; submitting
 * starts that agent in a fresh terminal via `xtralab:start-agent:<id>` with
 * a prompt that embeds the file path, cell index for notebooks, line range
 * and selected snippet.
 *
 * The same popup is provided on the `IAskAgent` token so the git diff
 * viewers can open it for a selected diff line range.
 */
const plugin: JupyterFrontEndPlugin<IAskAgent> = {
  id: PLUGIN_ID,
  description:
    'Prompt a coding agent about the selected code from editors, notebook cells and git diffs.',
  autoStart: true,
  provides: IAskAgent,
  optional: [IAgentRegistry, ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    agentRegistry: IAgentRegistry | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): IAskAgent => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    /** Agents that can receive an initial prompt on their command line. */
    const promptAgents = (): IAgent[] =>
      (agentRegistry?.agents ?? []).filter(
        agent => agent.promptArgs !== undefined
      );

    let popup: AskAgentPopup | null = null;
    let pill: HTMLButtonElement | null = null;
    let pillRequest: IAskAgentRequest | null = null;
    let settleTimer: number | null = null;
    let pointerIsDown = false;

    const closePopup = (): void => {
      const widget = popup;
      popup = null;
      widget?.dispose();
    };

    const hidePill = (): void => {
      pillRequest = null;
      if (pill !== null) {
        pill.style.display = 'none';
      }
    };

    const open = (request: IAskAgentRequest): void => {
      hidePill();
      closePopup();
      const widget = new AskAgentPopup({
        context: request.context,
        anchor: request.anchor,
        agents: promptAgents(),
        initialAgentId: readLastAgentId(),
        trans,
        onCancel: closePopup,
        onSubmit: (agentId, instruction) => {
          writeLastAgentId(agentId);
          closePopup();
          const prompt = buildPrompt(request.context, instruction);
          const args: { prompt: string; cwd?: string } = { prompt };
          if (request.context.cwd !== undefined) {
            args.cwd = request.context.cwd;
          }
          app.commands.execute(agentCommandId(agentId), args).catch(error => {
            console.error('xtralab: failed to start the agent', error);
            Notification.error(
              trans.__('Failed to start the agent — see the browser console.'),
              { autoClose: 5000 }
            );
          });
        }
      });
      popup = widget;
      widget.disposed.connect(() => {
        if (popup === widget) {
          popup = null;
        }
      });
      Widget.attach(widget, document.body);
    };

    const ensurePill = (): HTMLButtonElement => {
      if (pill !== null) {
        return pill;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jp-xtralab-AskAgent-pill jp-ThemedContainer';
      const icon = document.createElement('span');
      icon.className = 'jp-xtralab-AskAgent-pillIcon';
      askAgentIcon.element({ container: icon });
      const label = document.createElement('span');
      label.textContent = trans.__('Ask agent');
      button.append(icon, label);
      button.title = trans.__(
        'Prompt a coding agent about the selected code (%1)',
        CommandRegistry.formatKeystroke(ASK_AGENT_KEYS)
      );
      // Keep the editor focused (and its selection alive) while clicking.
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => {
        const request = pillRequest;
        hidePill();
        if (request !== null) {
          open(request);
        }
      });
      document.body.appendChild(button);
      pill = button;
      return button;
    };

    const showPill = (request: IAskAgentRequest): void => {
      const anchor = request.anchor;
      if (anchor === null) {
        hidePill();
        return;
      }
      const button = ensurePill();
      pillRequest = request;
      button.style.display = 'flex';
      // Measure after display so the rect is real, then sit the pill just
      // above the selection head (below it when that would leave the
      // viewport).
      const rect = button.getBoundingClientRect();
      let left = anchor.left;
      let top = anchor.top - rect.height - PILL_GAP;
      if (top < PILL_VIEWPORT_MARGIN) {
        top = anchor.bottom + PILL_GAP;
      }
      left = Math.max(
        PILL_VIEWPORT_MARGIN,
        Math.min(left, window.innerWidth - rect.width - PILL_VIEWPORT_MARGIN)
      );
      button.style.left = `${left}px`;
      button.style.top = `${top}px`;
    };

    const evaluateSelection = (): void => {
      if (popup !== null) {
        return;
      }
      const selection = document.getSelection();
      if (
        selection === null ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        hidePill();
        return;
      }
      const target = resolveEditorTarget(app.shell.currentWidget);
      if (target === null || !domSelectionInView(target.view, selection)) {
        hidePill();
        return;
      }
      if (promptAgents().length === 0) {
        hidePill();
        return;
      }
      const request = editorAskRequest(app);
      if (request === null) {
        hidePill();
        return;
      }
      showPill(request);
    };

    const scheduleEvaluate = (): void => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        // Mid-drag the selection is still moving; the pointerup listener
        // schedules another evaluation once the drag ends.
        if (!pointerIsDown) {
          evaluateSelection();
        }
      }, SELECTION_SETTLE_MS);
    };

    document.addEventListener('selectionchange', () => {
      if (popup !== null) {
        // Typing in the popup's textarea moves the document selection; the
        // pill must not resurface underneath the open popup.
        return;
      }
      hidePill();
      scheduleEvaluate();
    });
    document.addEventListener(
      'pointerdown',
      () => {
        pointerIsDown = true;
      },
      true
    );
    document.addEventListener(
      'pointerup',
      () => {
        pointerIsDown = false;
        scheduleEvaluate();
      },
      true
    );
    // Scrolling moves the selection away from the pill's fixed position;
    // capture phase because scroll events do not bubble.
    window.addEventListener(
      'scroll',
      () => {
        if (popup === null) {
          hidePill();
        }
      },
      true
    );
    window.addEventListener('resize', () => {
      if (popup === null) {
        hidePill();
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && popup === null) {
        hidePill();
      }
    });

    app.commands.addCommand(ASK_AGENT_COMMAND, {
      label: trans.__('Ask Agent About Selection…'),
      caption: trans.__(
        'Prompt a coding agent about the selected code in a new terminal'
      ),
      icon: askAgentIcon,
      isEnabled: () => resolveEditorTarget(app.shell.currentWidget) !== null,
      execute: () => {
        const request = editorAskRequest(app, { allowEmpty: true });
        if (request === null) {
          Notification.warning(
            trans.__('Select code in a text editor or notebook cell first.'),
            { autoClose: 3000 }
          );
          return;
        }
        open(request);
      }
    });

    // One binding per editing surface: file editors and notebooks.
    for (const selector of ['.jp-FileEditor', '.jp-Notebook']) {
      app.commands.addKeyBinding({
        command: ASK_AGENT_COMMAND,
        keys: [ASK_AGENT_KEYS],
        selector
      });
    }

    app.contextMenu.addItem({
      command: ASK_AGENT_COMMAND,
      selector: '.jp-FileEditor',
      rank: 1
    });
    app.contextMenu.addItem({
      command: ASK_AGENT_COMMAND,
      selector: '.jp-Notebook .jp-Cell',
      rank: 1
    });

    if (palette) {
      palette.addItem({
        command: ASK_AGENT_COMMAND,
        category: trans.__('Other')
      });
    }

    return { open, close: closePopup };
  }
};

export default plugin;
