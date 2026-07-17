import { Notification } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type { TranslationBundle } from '@jupyterlab/translation';
import {
  closeIcon,
  HTMLSelect,
  LabIcon,
  ReactWidget
} from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import type { Message } from '@lumino/messaging';
import * as React from 'react';

import type { IAgent } from '../launcher/agents';

import { contextSummary } from './popup';
import { serverPath } from './prompt';
import type { IQueuedPrompt, PromptQueue } from './queue';
import type { ISessionTarget } from './targetPicker';
import type { AskAgentTarget } from './tokens';

/** Command the context buttons dispatch; keeps the panel decoupled from the plugin. */
const HIGHLIGHT_LINES_COMMAND = 'xtralab:highlight-lines';

/**
 * Textarea height that fits `text` without scrolling, within sane bounds:
 * tall enough to look editable, short enough that one long comment cannot
 * crowd out the rest of the queue.
 */
function rowsFor(text: string): number {
  return Math.min(8, Math.max(2, text.split('\n').length));
}

/**
 * A target as a `<select>` option value: `session:<name>` for a running
 * agent terminal, `new:<agentId>` for a fresh terminal, `''` for a missing
 * target (the placeholder option).
 */
function encodeTarget(target: AskAgentTarget | null): string {
  if (target === null) {
    return '';
  }
  return target.kind === 'session'
    ? `session:${target.name}`
    : `new:${target.agentId}`;
}

function decodeTarget(value: string): AskAgentTarget | null {
  if (value.startsWith('session:')) {
    return { kind: 'session', name: value.slice('session:'.length) };
  }
  if (value.startsWith('new:')) {
    return { kind: 'new', agentId: value.slice('new:'.length) };
  }
  return null;
}

/**
 * Whether `target` can be sent to right now: its session is still running,
 * or its agent still accepts a command-line prompt.
 */
function targetIsLive(
  target: AskAgentTarget | null,
  agents: readonly IAgent[],
  targets: readonly ISessionTarget[]
): boolean {
  if (target === null) {
    return false;
  }
  return target.kind === 'session'
    ? targets.some(session => session.name === target.name)
    : agents.some(agent => agent.id === target.agentId);
}

function QueuePanelComponent(props: AskAgentQueuePanel.IOptions): JSX.Element {
  const {
    queue,
    commands,
    agents: readAgents,
    targets: readTargets,
    sending: readSending,
    trans,
    onSend,
    onClear
  } = props;

  // Snapshots for this render; the widget re-renders on every queue, agent
  // registry and terminal change, so these stay current.
  const items = queue.items;
  const agents = readAgents();
  const targets = readTargets();
  const sending = readSending();

  const complete = items.every(item => item.instruction.trim().length > 0);
  const targeted = items.every(item =>
    targetIsLive(item.target, agents, targets)
  );
  const canSend = items.length > 0 && complete && targeted && !sending;

  const jumpTo = (item: IQueuedPrompt): void => {
    const { context } = item;
    const path = serverPath(context);
    // The highlighter needs line numbers that index the working file:
    // notebook lines are cell-relative (or raw-JSON offsets), and diff
    // selections may come from another revision — just open the document
    // in those cases.
    const jump =
      context.cell === undefined &&
      context.startLine !== undefined &&
      context.linesInWorkingFile !== false &&
      PathExt.extname(path) !== '.ipynb'
        ? commands.execute(HIGHLIGHT_LINES_COMMAND, {
            path,
            line: context.startLine,
            endLine: context.endLine ?? context.startLine
          })
        : commands.execute('docmanager:open', { path });
    jump.catch((error: unknown) => {
      console.error('xtralab: failed to open the queued location', error);
      Notification.error(trans.__('Could not open %1', path), {
        autoClose: 3000
      });
    });
  };

  if (items.length === 0) {
    return (
      <div className="jp-xtralab-AskAgentQueue-body">
        <div className="jp-xtralab-AskAgentQueue-blank">
          {trans.__(
            'No queued prompts. Select code in an editor, notebook or git diff and choose “Queue” in the ask-agent popup; each prompt keeps its own destination and everything is sent in one go.'
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="jp-xtralab-AskAgentQueue-body">
      <ul className="jp-xtralab-AskAgentQueue-list">
        {items.map(item => {
          const summary = contextSummary(item.context, trans);
          const missing = item.instruction.trim().length === 0;
          const target = item.target;
          const live = targetIsLive(target, agents, targets);
          // Say what sending will do for this prompt — paste into a running
          // terminal, or start a fresh one — and badge it with the agent's
          // icon, so a mixed queue can be scanned without opening dropdowns.
          let icon: LabIcon | null = null;
          let targetTitle = trans.__(
            'The destination picked for this prompt is gone — choose another'
          );
          if (live && target !== null) {
            if (target.kind === 'session') {
              icon =
                targets.find(session => session.name === target.name)?.icon ??
                null;
              targetTitle = trans.__(
                'Sends into the agent running in terminal %1',
                target.name
              );
            } else {
              const agent = agents.find(entry => entry.id === target.agentId);
              icon = agent?.icon ?? null;
              targetTitle = trans.__(
                'Starts %1 in a new terminal',
                agent?.label ?? target.agentId
              );
            }
          }
          return (
            <li className="jp-xtralab-AskAgentQueue-item" key={item.id}>
              <div className="jp-xtralab-AskAgentQueue-itemHeader">
                <button
                  type="button"
                  className="jp-xtralab-AskAgentQueue-itemContext"
                  title={trans.__(
                    'Open %1 in the editor',
                    serverPath(item.context)
                  )}
                  onClick={() => jumpTo(item)}
                >
                  {summary}
                </button>
                <button
                  type="button"
                  className="jp-xtralab-AskAgentQueue-itemRemove"
                  title={trans.__('Remove from the queue')}
                  aria-label={trans.__('Remove from the queue')}
                  onClick={() => queue.remove(item.id)}
                >
                  <closeIcon.react
                    tag="span"
                    className="jp-xtralab-AskAgentQueue-itemRemoveIcon"
                  />
                </button>
              </div>
              {item.context.text.length > 0 && (
                <pre className="jp-xtralab-AskAgentQueue-snippet">
                  {item.context.text}
                </pre>
              )}
              {/* Uncontrolled on purpose: the queue re-renders through a
                  posted Lumino update, and a controlled value fed back that
                  late reverts keystrokes and jumps the caret. The `key` on
                  the surrounding <li> still remounts it per queue entry. */}
              <textarea
                className="jp-xtralab-AskAgentQueue-instruction"
                rows={rowsFor(item.instruction)}
                spellCheck={false}
                aria-invalid={missing}
                aria-label={trans.__('Instruction about %1', summary)}
                placeholder={trans.__('Describe the change…')}
                defaultValue={item.instruction}
                onChange={event =>
                  queue.updateInstruction(item.id, event.target.value)
                }
              />
              <div className="jp-xtralab-AskAgentQueue-itemTargetRow">
                <span
                  className="jp-xtralab-AskAgentQueue-itemTargetIcon"
                  aria-hidden="true"
                >
                  {icon !== null && <icon.react tag="span" />}
                </span>
                <HTMLSelect
                  className="jp-xtralab-AskAgentQueue-itemTarget"
                  aria-invalid={!live}
                  aria-label={trans.__('Send to')}
                  title={targetTitle}
                  value={live ? encodeTarget(target) : ''}
                  onChange={event => {
                    const picked = decodeTarget(event.target.value);
                    if (picked !== null) {
                      queue.updateTarget(item.id, picked);
                    }
                  }}
                >
                  {!live && (
                    <option value="" disabled>
                      {trans.__('Choose where to send…')}
                    </option>
                  )}
                  {targets.length > 0 && (
                    <optgroup label={trans.__('Running agents')}>
                      {targets.map(session => (
                        <option
                          key={session.name}
                          value={`session:${session.name}`}
                        >
                          {trans.__(
                            'Terminal %1 · %2',
                            session.name,
                            session.label
                          )}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {agents.length > 0 && (
                    <optgroup label={trans.__('New terminal')}>
                      {agents.map(agent => (
                        <option key={agent.id} value={`new:${agent.id}`}>
                          {trans.__('New terminal · %1', agent.label)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </HTMLSelect>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="jp-xtralab-AskAgentQueue-footer">
        {agents.length === 0 && targets.length === 0 && (
          <div className="jp-xtralab-AskAgentQueue-noTargets">
            {trans.__(
              'No agent accepts an initial prompt. Configure agents in the launcher settings.'
            )}
          </div>
        )}
        <div className="jp-xtralab-AskAgentQueue-actions">
          <button
            type="button"
            className="jp-xtralab-AskAgentQueue-clear"
            disabled={sending}
            title={trans.__('Remove every queued prompt')}
            onClick={onClear}
          >
            {trans.__('Clear')}
          </button>
          <button
            type="button"
            className="jp-xtralab-AskAgentQueue-send"
            disabled={!canSend}
            title={
              sending
                ? trans.__('Sending…')
                : !complete
                  ? trans.__('Every queued prompt needs an instruction')
                  : !targeted
                    ? trans.__('Every queued prompt needs a destination')
                    : trans.__(
                        'Send each queued prompt to its chosen destination'
                      )
            }
            onClick={() => {
              if (canSend) {
                onSend();
              }
            }}
          >
            {sending
              ? trans.__('Sending…')
              : trans._n('Send %1 prompt', 'Send %1 prompts', items.length)}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The right-sidebar review panel for queued ask-agent prompts.
 *
 * Lists every queued comment — jump-to-code context line, snippet preview,
 * editable instruction, its own destination picker, remove button — plus a
 * send button that flushes the whole queue in one go: prompts sharing a
 * destination are combined into one numbered message, and each destination
 * gets its own delivery. The widget re-renders on queue changes itself; the
 * plugin additionally ties it to the agent registry and terminal signals so
 * the destination choices stay current.
 */
export class AskAgentQueuePanel extends ReactWidget {
  constructor(options: AskAgentQueuePanel.IOptions) {
    super();
    this._options = options;
    this.addClass('jp-xtralab-AskAgentQueue');
    options.queue.changed.connect(this._onQueueChanged, this);
  }

  render(): JSX.Element {
    return <QueuePanelComponent {...this._options} />;
  }

  /**
   * Dispose on close (e.g. the close button when the panel has been dragged
   * to the main area) rather than leaving a detached, reusable widget
   * behind. The plugin recreates the panel in the side area on demand; the
   * queue itself lives on in the model.
   */
  protected onCloseRequest(msg: Message): void {
    super.onCloseRequest(msg);
    this.dispose();
  }

  private _onQueueChanged(): void {
    this.update();
  }

  private _options: AskAgentQueuePanel.IOptions;
}

/**
 * A namespace for `AskAgentQueuePanel` statics.
 */
export namespace AskAgentQueuePanel {
  /** Construction options for {@link AskAgentQueuePanel}. */
  export interface IOptions {
    /** The queue the panel lists and edits. */
    queue: PromptQueue;

    /** Command registry used to open queued locations in the editor. */
    commands: CommandRegistry;

    /** Live reader of the prompt-capable agents (called on every render). */
    agents: () => IAgent[];

    /** Live reader of the running agent terminals (called on every render). */
    targets: () => ISessionTarget[];

    /**
     * Live reader of whether a batch send is in flight (called on every
     * render). While true the send and clear buttons are disabled, so one
     * flush cannot be double-delivered.
     */
    sending: () => boolean;

    /** Translation bundle for the panel's own labels. */
    trans: TranslationBundle;

    /**
     * Send every queued prompt to its own destination (the panel only calls
     * this while all instructions and destinations are valid).
     */
    onSend: () => void;

    /** Clear the queue (the plugin offers an undo toast). */
    onClear: () => void;
  }
}
