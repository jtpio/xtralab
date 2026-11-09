import type { TranslationBundle } from '@jupyterlab/translation';
import { addIcon, LabIcon } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { IAgent } from '../launcher/agents';
import type { AskAgentTarget } from './tokens';

/**
 * A running agent offered as a prompt target: an agent terminal from
 * `IAgentTerminals`, or a session of an agent that does not run in a
 * terminal (such as an open chat). The plugin resolves the labels and icons
 * so these components stay presentation-only.
 */
export interface ISessionTarget {
  /**
   * Where a prompt to this target goes.
   */
  target: Exclude<AskAgentTarget, { kind: 'new' }>;

  /**
   * The `targetKey` of {@link target}.
   */
  key: string;

  /**
   * The display label (usually the agent's name).
   */
  label: string;

  /**
   * Secondary text that tells sessions apart: the terminal name, or the
   * session name.
   */
  detail: string;

  /**
   * What sending to the target does, for tooltips.
   */
  description: string;

  /**
   * The agent's latest activity line, when one is available.
   */
  activity: string | null;

  /**
   * The running agent's icon.
   */
  icon: LabIcon;
}

/**
 * Keyboard support for the radiogroups, per the ARIA radio pattern: one tab
 * stop, arrow keys move and select — the handler clicks the neighbour and
 * the re-render moves the roving tabindex along.
 */
function onRadioGroupKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  let delta: number;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      delta = 1;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      delta = -1;
      break;
    default:
      return;
  }
  const radios = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  );
  const index = radios.findIndex(radio => radio === event.target);
  if (index === -1) {
    return;
  }
  event.preventDefault();
  const next = radios[(index + delta + radios.length) % radios.length];
  next.focus();
  next.click();
}

/**
 * The chip row picking where a prompt goes: a new session of the selected
 * agent ("New terminal") plus one chip per running agent session. Renders
 * nothing while no session is running (a new session is then the only
 * possibility).
 */
export function TargetChips(props: {
  agents: IAgent[];
  targets: ISessionTarget[];
  /**
   * The key of the selected session, or `null` for a new session.
   */
  targetKey: string | null;
  /**
   * The label of the new-session chip, for example "New terminal".
   */
  newLabel: string;
  trans: TranslationBundle;
  onSelect: (targetKey: string | null) => void;
}): JSX.Element | null {
  const { agents, targets, targetKey, newLabel, trans, onSelect } = props;
  if (targets.length === 0) {
    return null;
  }
  return (
    <div
      className="jp-xtralab-AskAgent-targets"
      role="radiogroup"
      aria-label={trans.__('Send to')}
      onKeyDown={onRadioGroupKeyDown}
    >
      {agents.length > 0 && (
        <button
          type="button"
          role="radio"
          aria-checked={targetKey === null}
          tabIndex={targetKey === null ? 0 : -1}
          title={trans.__('Start the selected agent')}
          className={
            'jp-xtralab-AskAgent-targetButton' +
            (targetKey === null ? ' jp-mod-selected' : '')
          }
          // Keep focus where the user is typing while picking a target.
          onMouseDown={event => event.preventDefault()}
          onClick={() => onSelect(null)}
        >
          <addIcon.react
            tag="span"
            className="jp-xtralab-AskAgent-targetIcon"
          />
          <span className="jp-xtralab-AskAgent-targetLabel">{newLabel}</span>
        </button>
      )}
      {targets.map(target => (
        <button
          key={target.key}
          type="button"
          role="radio"
          aria-checked={target.key === targetKey}
          tabIndex={target.key === targetKey ? 0 : -1}
          title={
            target.activity
              ? trans.__(
                  '%1 · %2 — %3',
                  target.label,
                  target.detail,
                  target.activity
                )
              : trans.__('%1 · %2', target.label, target.detail)
          }
          className={
            'jp-xtralab-AskAgent-targetButton' +
            (target.key === targetKey ? ' jp-mod-selected' : '')
          }
          onMouseDown={event => event.preventDefault()}
          onClick={() => onSelect(target.key)}
        >
          <target.icon.react
            tag="span"
            className="jp-xtralab-AskAgent-targetIcon"
          />
          <span className="jp-xtralab-AskAgent-targetLabel">
            {target.label}
          </span>
          <span className="jp-xtralab-AskAgent-targetName">
            {target.detail}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The icon radiogroup picking which agent a new terminal starts with.
 * Renders nothing when no agent accepts an initial prompt.
 */
export function AgentChoices(props: {
  agents: IAgent[];
  agentId: string;
  trans: TranslationBundle;
  onSelect: (agentId: string) => void;
}): JSX.Element | null {
  const { agents, agentId, trans, onSelect } = props;
  if (agents.length === 0) {
    return null;
  }
  return (
    <div
      className="jp-xtralab-AskAgent-agents"
      role="radiogroup"
      aria-label={trans.__('Agent')}
      onKeyDown={onRadioGroupKeyDown}
    >
      {agents.map(agent => (
        <button
          key={agent.id}
          type="button"
          role="radio"
          aria-checked={agent.id === agentId}
          tabIndex={agent.id === agentId ? 0 : -1}
          title={agent.label}
          aria-label={agent.label}
          className={
            'jp-xtralab-AskAgent-agentButton' +
            (agent.id === agentId ? ' jp-mod-selected' : '')
          }
          onMouseDown={event => event.preventDefault()}
          onClick={() => onSelect(agent.id)}
        >
          <agent.icon.react
            tag="span"
            className="jp-xtralab-AskAgent-agentIcon"
          />
        </button>
      ))}
    </div>
  );
}
