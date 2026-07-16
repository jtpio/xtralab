import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, Notification } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { terminalIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';

import type { IAgent } from '../launcher/agents';
import { agentCommandId, IAgentRegistry } from '../launcher/tokens';
import { IAgentTerminals } from '../terminals/tokens';

import {
  domSelectionInView,
  editorAskRequest,
  resolveEditorTarget
} from './editorSelection';
import { askAgentIcon } from './icons';
import { AskAgentPopup } from './popup';
import { buildBatchPrompt, buildPrompt, serverPath } from './prompt';
import { IQueuedPrompt, loadQueuedPrompts, PromptQueue } from './queue';
import { AskAgentQueuePanel } from './queuePanel';
import type { ISessionTarget } from './targetPicker';
import {
  ASK_AGENT_COMMAND,
  AskAgentTarget,
  IAskAgent,
  IAskAgentContext,
  IAskAgentRequest
} from './tokens';

const PLUGIN_ID = 'xtralab:ask-agent';

/** Command id that reveals the queued-prompts panel. */
const QUEUE_PANEL_COMMAND = 'xtralab:ask-agent-queue';

/** Widget id of the queued-prompts side panel. */
const QUEUE_PANEL_ID = 'xtralab-ask-agent-queue';

/** `localStorage` key remembering the last agent picked in the popup. */
const LAST_AGENT_STORAGE_KEY = 'xtralab:ask-agent:agent';

/** `localStorage` key remembering the last target picked in the popup. */
const LAST_TARGET_STORAGE_KEY = 'xtralab:ask-agent:target';

/** Stored target value for "start the agent in a new terminal". */
const NEW_TARGET_VALUE = 'new';

/** Stored-target prefix for an existing session; the session name follows. */
const SESSION_TARGET_PREFIX = 'session:';

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

function readLastTarget(): string | null {
  try {
    return window.localStorage.getItem(LAST_TARGET_STORAGE_KEY);
  } catch {
    // See readLastAgentId — the popup then applies its default target.
    return null;
  }
}

function writeLastTarget(value: string): void {
  try {
    window.localStorage.setItem(LAST_TARGET_STORAGE_KEY, value);
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
 * types an instruction, picks one of the launcher's agents and picks where
 * the prompt goes; submitting either starts that agent in a fresh terminal
 * via `xtralab:start-agent:<id>`, or pastes the prompt into an agent already
 * running in one of the open terminal sessions (via `IAgentTerminals`; the
 * agent CLIs queue prompts that arrive while they are busy). Sends to a
 * running agent stay in the background — focus never leaves the editor, and
 * a success toast offers to open the terminal. Either way the prompt embeds
 * the file path, cell index for notebooks, line range and selected snippet.
 *
 * The popup's Queue button (or Accel+Enter) defers the send instead: the
 * comment lands in a persistent queue, stamped with the popup's selected
 * destination — every queued prompt is independent and may aim at a
 * different agent or session. A right-sidebar panel reviews the queue
 * (edit, retarget, remove) and flushes it in one go, combining prompts that
 * share a destination into a single numbered message. The queue survives
 * page reloads.
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
  optional: [
    IAgentRegistry,
    ICommandPalette,
    ITranslator,
    IAgentTerminals,
    ILabShell
  ],
  activate: (
    app: JupyterFrontEnd,
    agentRegistry: IAgentRegistry | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null,
    agentTerminals: IAgentTerminals | null,
    labShell: ILabShell | null
  ): IAskAgent => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    /** Agents that can receive an initial prompt on their command line. */
    const promptAgents = (): IAgent[] =>
      (agentRegistry?.agents ?? []).filter(
        agent => agent.promptArgs !== undefined
      );

    /**
     * Running agent terminals offered as prompt targets, each resolved to
     * its agent's icon the same way the terminals panel badges its rows
     * (matching either the configured command or the canonical id, falling
     * back to the plain terminal icon when the agent has since been removed
     * from the settings). Unlike {@link promptAgents} this does not require
     * `promptArgs`: pasting into a running TUI needs no command-line recipe.
     */
    const sessionTargets = (): ISessionTarget[] =>
      (agentTerminals?.sessions() ?? []).map(session => ({
        name: session.name,
        label: session.label,
        activity: session.activity,
        icon:
          (agentRegistry?.agents ?? []).find(
            agent =>
              agent.command === session.command || agent.id === session.command
          )?.icon ?? terminalIcon
      }));

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

    /** Open the named terminal's tab (the success toast's call to action). */
    const openTerminal = (name: string): void => {
      app.commands.execute('terminal:open', { name }).catch(reason => {
        console.error('xtralab: failed to open the terminal', reason);
      });
    };

    /**
     * Paste `prompt` into the running agent in session `name`. Delivery is
     * background — focus stays where it is — so `successMessage` is toasted
     * with an "Open" action instead. Failures are toasted too; the promise
     * still rejects so callers can chain their own cleanup to success only.
     */
    const deliverToSession = async (
      name: string,
      prompt: string,
      successMessage: string
    ): Promise<void> => {
      if (agentTerminals === null) {
        // Unreachable in practice: session targets are only offered when
        // the terminals plugin is present.
        return;
      }
      try {
        await agentTerminals.sendPrompt(name, prompt);
      } catch (error) {
        console.error(
          'xtralab: failed to send the prompt to the terminal',
          error
        );
        const detail = error instanceof Error ? error.message : '';
        Notification.error(
          detail.length > 0
            ? trans.__('Failed to send the prompt: %1', detail)
            : trans.__('Failed to send the prompt — see the browser console.'),
          { autoClose: 5000 }
        );
        throw error;
      }
      Notification.success(successMessage, {
        autoClose: 3000,
        actions: [
          { label: trans.__('Open'), callback: () => openTerminal(name) }
        ]
      });
    };

    /**
     * Start `agentId` in a fresh terminal with `prompt` on its command
     * line. Failures are toasted; the promise still rejects so callers can
     * chain their own cleanup to success only.
     */
    const startAgentTerminal = async (
      agentId: string,
      prompt: string,
      cwd?: string
    ): Promise<void> => {
      const args: { prompt: string; cwd?: string } = { prompt };
      if (cwd !== undefined) {
        args.cwd = cwd;
      }
      try {
        await app.commands.execute(agentCommandId(agentId), args);
      } catch (error) {
        console.error('xtralab: failed to start the agent', error);
        Notification.error(
          trans.__('Failed to start the agent — see the browser console.'),
          { autoClose: 5000 }
        );
        throw error;
      }
    };

    // The queue feature needs a side area to dock the review panel into, so
    // everything below stays off (and the popup hides its Queue button)
    // without the full Lab shell.
    let queue: PromptQueue | null = null;
    let queuePrompt:
      | ((
          request: IAskAgentRequest,
          target: AskAgentTarget,
          instruction: string
        ) => void)
      | null = null;

    if (labShell !== null) {
      const promptQueue = new PromptQueue(loadQueuedPrompts());
      queue = promptQueue;
      let panel: AskAgentQueuePanel | null = null;

      /**
       * The prompt (and working directory) for a batch sent to a new
       * terminal. When every item agrees on a repository root the terminal
       * starts there and the item paths stay relative to it; a mixed batch
       * starts at the server root instead, with every locator rewritten to
       * a server-relative path so none of them depends on the terminal's
       * cwd.
       */
      const newTerminalBatch = (
        items: readonly IQueuedPrompt[]
      ): { prompt: string; cwd?: string } => {
        const cwds = new Set(items.map(item => item.context.cwd ?? ''));
        if (cwds.size === 1) {
          const shared = [...cwds][0];
          return {
            prompt: buildBatchPrompt(items),
            ...(shared.length > 0 ? { cwd: shared } : {})
          };
        }
        const normalized = items.map(({ context, instruction }) => {
          const flattened: IAskAgentContext = {
            ...context,
            path: serverPath(context)
          };
          delete flattened.cwd;
          return { context: flattened, instruction };
        });
        return { prompt: buildBatchPrompt(normalized) };
      };

      /**
       * Flush the queue: prompts are grouped by destination — every prompt
       * is independent and may target a different agent or session — and
       * each group goes out as one numbered message. A group's prompts
       * leave the queue only when its delivery succeeds, so one dead
       * session never loses the comments aimed elsewhere.
       */
      const sendQueue = (): void => {
        const groups = new Map<
          string,
          { target: AskAgentTarget; items: IQueuedPrompt[] }
        >();
        for (const item of promptQueue.items) {
          if (item.target === null) {
            // The panel disables sending while a target is missing; skip
            // defensively if a send races a target loss.
            continue;
          }
          const key =
            item.target.kind === 'session'
              ? `session:${item.target.name}`
              : `new:${item.target.agentId}`;
          const group = groups.get(key) ?? { target: item.target, items: [] };
          group.items.push(item);
          groups.set(key, group);
        }
        for (const { target, items } of groups.values()) {
          const ids = items.map(item => item.id);
          if (target.kind === 'session') {
            const label =
              sessionTargets().find(entry => entry.name === target.name)
                ?.label ?? target.name;
            deliverToSession(
              target.name,
              buildBatchPrompt(items),
              trans._n(
                'Sent %1 prompt to %2',
                'Sent %1 prompts to %2',
                items.length,
                label
              )
            )
              .then(() => promptQueue.removeMany(ids))
              .catch(() => {
                // Reported by the helper; this group is kept for a retry.
              });
          } else {
            const { prompt, cwd } = newTerminalBatch(items);
            startAgentTerminal(target.agentId, prompt, cwd)
              .then(() => promptQueue.removeMany(ids))
              .catch(() => {
                // Reported by the helper; this group is kept for a retry.
              });
          }
        }
      };

      /** Empty the queue, with an undo toast (typed comments are work). */
      const clearQueue = (): void => {
        const removed = promptQueue.items;
        if (removed.length === 0) {
          return;
        }
        promptQueue.clear();
        Notification.info(
          trans._n(
            'Removed %1 queued prompt',
            'Removed %1 queued prompts',
            removed.length
          ),
          {
            autoClose: 5000,
            actions: [
              {
                label: trans.__('Undo'),
                // Prompts queued after the clear are newer; keep them,
                // after the restored ones.
                callback: () =>
                  promptQueue.reset([...removed, ...promptQueue.items])
              }
            ]
          }
        );
      };

      const ensurePanel = (): AskAgentQueuePanel => {
        if (panel === null || panel.isDisposed) {
          const created = new AskAgentQueuePanel({
            queue: promptQueue,
            commands: app.commands,
            agents: promptAgents,
            targets: sessionTargets,
            trans,
            onSend: sendQueue,
            onClear: clearQueue
          });
          created.id = QUEUE_PANEL_ID;
          created.title.icon = askAgentIcon;
          created.title.label = trans.__('Prompt Queue');
          created.title.caption = trans.__('Queued ask-agent prompts');
          // Closable so it gets a close button if the user drags it out of
          // the side area; closing disposes it, and it is recreated on
          // demand (same arrangement as the walkthrough panel).
          created.title.closable = true;
          // The panel re-renders on queue changes itself; the chips also
          // mirror the live agent list and terminal sessions.
          agentRegistry?.changed.connect(created.update, created);
          agentTerminals?.changed.connect(created.update, created);
          labShell.add(created, 'right', { rank: 900 });
          created.disposed.connect(() => {
            if (panel === created) {
              panel = null;
            }
          });
          panel = created;
        }
        return panel;
      };

      const revealPanel = (): void => {
        labShell.activateById(ensurePanel().id);
      };

      queuePrompt = (request, target, instruction) => {
        const wasEmpty = promptQueue.items.length === 0;
        // Queueing is a target choice like sending: remember it for the
        // next popup's preselection.
        if (target.kind === 'session') {
          writeLastTarget(SESSION_TARGET_PREFIX + target.name);
        } else {
          writeLastAgentId(target.agentId);
          writeLastTarget(NEW_TARGET_VALUE);
        }
        promptQueue.add(request.context, instruction, target);
        // Queueing is background like a session send: hand focus straight
        // back to the widget the ask came from.
        app.shell.currentWidget?.activate();
        const queuePanel = ensurePanel();
        if (queuePanel.isVisible) {
          // The list visibly grows; no extra feedback needed.
          return;
        }
        if (wasEmpty) {
          // First prompt of a batch: reveal the panel once, so the user
          // sees where queued prompts accumulate. Later additions respect
          // a deliberately closed sidebar and toast instead.
          labShell.activateById(queuePanel.id);
          return;
        }
        Notification.info(
          trans._n(
            '%1 prompt queued',
            '%1 prompts queued',
            promptQueue.items.length
          ),
          {
            autoClose: 3000,
            actions: [{ label: trans.__('Review'), callback: revealPanel }]
          }
        );
      };

      app.commands.addCommand(QUEUE_PANEL_COMMAND, {
        label: trans.__('Show Ask-Agent Prompt Queue'),
        caption: trans.__(
          'Review the queued ask-agent prompts and send them together'
        ),
        icon: askAgentIcon,
        execute: revealPanel
      });

      // A queue restored from a previous page load should be discoverable
      // without queueing anything new: recreate its sidebar tab (collapsed).
      if (promptQueue.items.length > 0) {
        ensurePanel();
      }
    }

    const open = (request: IAskAgentRequest): void => {
      hidePill();
      closePopup();
      const agents = promptAgents();
      const targets = sessionTargets();
      // Preselect where the prompt goes. Queueing into a running agent is
      // the common follow-up loop, so a live session wins by default — the
      // last-used one when it is still running, otherwise the first — unless
      // the user explicitly chose a new terminal last time (and one can
      // still be started).
      const storedTarget = readLastTarget();
      let initialTargetName: string | null =
        targets.length > 0 ? targets[0].name : null;
      if (storedTarget === NEW_TARGET_VALUE && agents.length > 0) {
        initialTargetName = null;
      } else if (
        storedTarget !== null &&
        storedTarget.startsWith(SESSION_TARGET_PREFIX)
      ) {
        const name = storedTarget.slice(SESSION_TARGET_PREFIX.length);
        if (targets.some(target => target.name === name)) {
          initialTargetName = name;
        }
      }
      const enqueue = queuePrompt;
      const widget = new AskAgentPopup({
        context: request.context,
        anchor: request.anchor,
        agents,
        targets,
        initialAgentId: readLastAgentId(),
        initialTargetName,
        queueCount: queue?.items.length,
        trans,
        onCancel: closePopup,
        onQueue:
          enqueue === null
            ? undefined
            : (target, instruction) => {
                closePopup();
                enqueue(request, target, instruction);
              },
        onSubmit: (target, instruction) => {
          closePopup();
          const prompt = buildPrompt(request.context, instruction);
          if (target.kind === 'session') {
            writeLastTarget(SESSION_TARGET_PREFIX + target.name);
            // The send is background, so hand focus straight back to the
            // widget the ask came from (the editor or diff under the popup);
            // disposing the popup alone would drop it on `document.body`.
            app.shell.currentWidget?.activate();
            const label =
              targets.find(entry => entry.name === target.name)?.label ??
              target.name;
            deliverToSession(
              target.name,
              prompt,
              trans.__('Prompt sent to %1', label)
            ).catch(() => {
              // Reported by the helper.
            });
            return;
          }
          writeLastAgentId(target.agentId);
          writeLastTarget(NEW_TARGET_VALUE);
          startAgentTerminal(target.agentId, prompt, request.context.cwd).catch(
            () => {
              // Reported by the helper.
            }
          );
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
      // The popup can send somewhere as long as an agent takes a prompt on
      // its command line (new terminal) or one is already running (existing
      // session) — only with neither is there nothing to offer.
      if (
        promptAgents().length === 0 &&
        (agentTerminals?.sessions() ?? []).length === 0
      ) {
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
        'Prompt a coding agent about the selected code in a new or running terminal'
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
      if (queue !== null) {
        palette.addItem({
          command: QUEUE_PANEL_COMMAND,
          category: trans.__('Other')
        });
      }
    }

    return { open, close: closePopup };
  }
};

export default plugin;
