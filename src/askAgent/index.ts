import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, Notification } from '@jupyterlab/apputils';
import { IStateDB } from '@jupyterlab/statedb';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { terminalIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONValue } from '@lumino/coreutils';
import { Debouncer } from '@lumino/polling';
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
import {
  deserializeQueuedPrompts,
  IQueuedPrompt,
  PromptQueue,
  serializeQueuedPrompts
} from './queue';
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

const QUEUE_PANEL_COMMAND = 'xtralab:ask-agent-queue';

const QUEUE_PANEL_ID = 'xtralab-ask-agent-queue';

const LAST_AGENT_STATE_KEY = 'xtralab:ask-agent:agent';

const LAST_TARGET_STATE_KEY = 'xtralab:ask-agent:target';

const QUEUE_STATE_KEY = 'xtralab:ask-agent:queue';

const QUEUE_PERSIST_MS = 500;

const NEW_TARGET_VALUE = 'new';

const SESSION_TARGET_PREFIX = 'session:';

/** Delay before showing the pill, so it does not flicker along a drag. */
const SELECTION_SETTLE_MS = 250;

/**
 * `Accel I` would be the familiar "inline chat" chord but CodeMirror's
 * default keymap owns `Mod-i` and prevents-default before Lumino sees it;
 * `Accel .` is free in the editor, the browser and JupyterLab.
 */
const ASK_AGENT_KEYS = 'Accel .';

const PILL_GAP = 6;

const PILL_VIEWPORT_MARGIN = 8;

/**
 * Prompt a coding agent about selected code: a pill/popup over editor,
 * notebook-cell and git-diff selections sends the instruction to a fresh
 * agent terminal or into a running one, or defers it into a persistent
 * queue reviewed in a right-sidebar panel and flushed as one batch.
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
    ILabShell,
    ILayoutRestorer,
    IStateDB
  ],
  activate: (
    app: JupyterFrontEnd,
    agentRegistry: IAgentRegistry | null,
    palette: ICommandPalette | null,
    translator: ITranslator | null,
    agentTerminals: IAgentTerminals | null,
    labShell: ILabShell | null,
    restorer: ILayoutRestorer | null,
    state: IStateDB | null
  ): IAskAgent => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    /** Best-effort state-database write; a failure only loses a restored default. */
    const saveState = (key: string, value: ReadonlyPartialJSONValue): void => {
      state?.save(key, value).catch(error => {
        console.error('xtralab: failed to persist ask-agent state', error);
      });
    };

    // Last-used picks, restored asynchronously but read synchronously by
    // the popup.
    let lastAgentId: string | null = null;
    let lastTarget: string | null = null;
    if (state !== null) {
      void Promise.all([
        state.fetch(LAST_AGENT_STATE_KEY),
        state.fetch(LAST_TARGET_STATE_KEY)
      ])
        .then(([agentId, target]) => {
          if (typeof agentId === 'string') {
            lastAgentId = agentId;
          }
          if (typeof target === 'string') {
            lastTarget = target;
          }
        })
        .catch(() => {
          // Missing or unreadable state just means default picks.
        });
    }

    const rememberAgent = (agentId: string): void => {
      lastAgentId = agentId;
      saveState(LAST_AGENT_STATE_KEY, agentId);
    };

    const rememberTarget = (value: string): void => {
      lastTarget = value;
      saveState(LAST_TARGET_STATE_KEY, value);
    };

    /**
     * Agents that can receive an initial prompt on their command line.
     */
    const promptAgents = (): IAgent[] =>
      (agentRegistry?.agents ?? []).filter(
        agent => agent.promptArgs !== undefined
      );

    /**
     * Running agent terminals offered as prompt targets, badged with the
     * matching agent's icon like the terminals panel (configured command or
     * canonical id). Pasting into a running TUI needs no `promptArgs`.
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

    const openTerminal = (name: string): void => {
      app.commands.execute('terminal:open', { name }).catch(reason => {
        console.error('xtralab: failed to open the terminal', reason);
      });
    };

    /**
     * Paste `prompt` into the running agent in session `name`, in the
     * background. Failures are toasted but still reject, so callers can
     * chain their own cleanup to success only.
     */
    const deliverToSession = async (
      name: string,
      prompt: string,
      successMessage: string
    ): Promise<void> => {
      if (agentTerminals === null) {
        // Session targets are only offered when the terminals plugin is present.
        throw new Error('xtralab: agent terminals are unavailable');
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
     * line. Failures are toasted but still reject.
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

    // The queue needs a side area for its review panel, so it stays off
    // (and the popup hides its Queue button) without the full Lab shell.
    let queue: PromptQueue | null = null;
    let queuePrompt:
      | ((
          request: IAskAgentRequest,
          target: AskAgentTarget,
          instruction: string
        ) => void)
      | null = null;

    if (labShell !== null) {
      const promptQueue = new PromptQueue();
      queue = promptQueue;
      let panel: AskAgentQueuePanel | null = null;
      let flushing = false;

      // Debounced so typing in the panel's textareas does not write on
      // each keystroke.
      const persistQueue = new Debouncer(() => {
        saveState(QUEUE_STATE_KEY, serializeQueuedPrompts(promptQueue.items));
      }, QUEUE_PERSIST_MS);
      promptQueue.changed.connect(() => {
        void persistQueue.invoke();
      });

      /**
       * The prompt (and cwd) for a batch sent to a new terminal: a shared
       * repository root becomes the cwd; a mixed batch starts at the server
       * root with every locator rewritten server-relative instead.
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
       * Flush the queue: prompts are grouped by destination and each group
       * goes out as one numbered message, leaving the queue only when its
       * delivery succeeds. One flush at a time — a second click mid-flight
       * would re-send every still-queued group.
       */
      const sendQueue = (): void => {
        if (flushing) {
          return;
        }
        const groups = new Map<
          string,
          { target: AskAgentTarget; items: IQueuedPrompt[] }
        >();
        for (const item of promptQueue.items) {
          if (item.target === null) {
            // The panel disables sending without a target; skip if a send
            // races a target loss.
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
        const deliveries: Promise<void>[] = [];
        for (const { target, items } of groups.values()) {
          /**
           * Remove the delivered prompts — except any edited or retargeted
           * in flight: an edit makes a new object, so identity is the
           * "unchanged" check and the edited prompt stays queued.
           */
          const delivered = (): void => {
            promptQueue.removeMany(
              items
                .filter(item => promptQueue.items.includes(item))
                .map(item => item.id)
            );
          };
          if (target.kind === 'session') {
            const label =
              sessionTargets().find(entry => entry.name === target.name)
                ?.label ?? target.name;
            deliveries.push(
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
                .then(delivered)
                .catch(() => {
                  // Reported by the helper; this group is kept for a retry.
                })
            );
          } else {
            const { prompt, cwd } = newTerminalBatch(items);
            deliveries.push(
              startAgentTerminal(target.agentId, prompt, cwd)
                .then(delivered)
                .catch(() => {
                  // Reported by the helper; this group is kept for a retry.
                })
            );
          }
        }
        if (deliveries.length === 0) {
          return;
        }
        flushing = true;
        panel?.update();
        // Every delivery caught its own failure, so this settles either way.
        void Promise.all(deliveries).then(() => {
          flushing = false;
          panel?.update();
        });
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
                // Prompts queued after the clear are newer; keep them after
                // the restored ones.
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
            sending: () => flushing,
            trans,
            onSend: sendQueue,
            onClear: clearQueue
          });
          created.id = QUEUE_PANEL_ID;
          created.title.icon = askAgentIcon;
          created.title.label = trans.__('Prompt Queue');
          created.title.caption = trans.__('Queued ask-agent prompts');
          // Closable so it gets a close button when dragged out of the side
          // area; closing disposes it and it is recreated on demand.
          created.title.closable = true;
          // The chips mirror the live agent list and terminal sessions.
          agentRegistry?.changed.connect(created.update, created);
          agentTerminals?.changed.connect(created.update, created);
          labShell.add(created, 'right', { rank: 900 });
          restorer?.add(created, QUEUE_PANEL_ID);
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
          rememberTarget(SESSION_TARGET_PREFIX + target.name);
        } else {
          rememberAgent(target.agentId);
          rememberTarget(NEW_TARGET_VALUE);
        }
        promptQueue.add(request.context, instruction, target);
        // Queueing is background: hand focus back to the widget the ask
        // came from.
        app.shell.currentWidget?.activate();
        const queuePanel = ensurePanel();
        if (queuePanel.isVisible) {
          // The list visibly grows; no extra feedback needed.
          return;
        }
        if (wasEmpty) {
          // Reveal the panel once for the first prompt; later additions
          // respect a deliberately closed sidebar and toast instead.
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

      // Prompts queued before the fetch resolves are newer and stay, after
      // the restored ones; the tab is recreated so the restore is discoverable.
      if (state !== null) {
        void state
          .fetch(QUEUE_STATE_KEY)
          .then(value => {
            const restored = deserializeQueuedPrompts(value);
            if (restored.length > 0) {
              promptQueue.reset([...restored, ...promptQueue.items]);
              ensurePanel();
            }
          })
          .catch(() => {
            // Missing or unreadable state just means an empty queue.
          });
      }
    }

    const open = (request: IAskAgentRequest): void => {
      hidePill();
      closePopup();
      const agents = promptAgents();
      const targets = sessionTargets();
      // Preselect: a live session wins (last-used if still running, else the
      // first) unless a new terminal was last chosen and can still start.
      const storedTarget = lastTarget;
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
        initialAgentId: lastAgentId,
        initialTargetName,
        queueCount: queue?.items.length,
        trans,
        onCancel: restoreFocus => {
          closePopup();
          if (restoreFocus) {
            app.shell.currentWidget?.activate();
          }
        },
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
            rememberTarget(SESSION_TARGET_PREFIX + target.name);
            // The send is background: hand focus back to the widget the ask
            // came from — disposing the popup alone drops it on `document.body`.
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
          rememberAgent(target.agentId);
          rememberTarget(NEW_TARGET_VALUE);
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
      // Measure after display so the rect is real; the pill sits above the
      // selection head, below it when that would leave the viewport.
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
      // Only with no prompt-capable agent and no running session is there
      // nothing to offer.
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

    // Mid-drag the selection is still moving; the pointerup listener
    // re-invokes once the drag ends.
    const settled = new Debouncer(() => {
      if (!pointerIsDown) {
        evaluateSelection();
      }
    }, SELECTION_SETTLE_MS);

    document.addEventListener('selectionchange', () => {
      if (popup !== null) {
        // Typing in the popup moves the document selection; the pill must
        // not resurface underneath it.
        return;
      }
      hidePill();
      void settled.invoke();
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
        void settled.invoke();
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
      if (event.key !== 'Escape') {
        return;
      }
      if (popup !== null) {
        // The popup's own handler consumes Escape while focus is inside it;
        // here focus is elsewhere, so close and restore focus.
        closePopup();
        app.shell.currentWidget?.activate();
        return;
      }
      hidePill();
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
