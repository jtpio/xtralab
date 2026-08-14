import type { TranslationBundle } from '@jupyterlab/translation';
import { addIcon, LabIcon } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { IAgent } from '../launcher/agents';

/**
 * A running agent terminal offered as a prompt target: the session data
 * from `IAgentTerminals` plus the matching agent's icon, resolved by the
 * plugin so these components stay presentation-only.
 */
export interface ISessionTarget {
  name: string;

  label: string;

  activity: string | null;

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
 * The chip row picking where a prompt goes: "New terminal" plus one chip
 * per running agent session. Renders nothing while no session is running
 * (a new terminal is then the only possibility).
 */
export function TargetChips(props: {
  agents: IAgent[];
  targets: ISessionTarget[];
  /**
   * The selected session name, or `null` for a new terminal.
   */
  targetName: string | null;
  trans: TranslationBundle;
  onSelect: (targetName: string | null) => void;
}): JSX.Element | null {
  const { agents, targets, targetName, trans, onSelect } = props;
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
          aria-checked={targetName === null}
          tabIndex={targetName === null ? 0 : -1}
          title={trans.__('Start the agent in a new terminal')}
          className={
            'jp-xtralab-AskAgent-targetButton' +
            (targetName === null ? ' jp-mod-selected' : '')
          }
          // Keep focus where the user is typing while picking a target.
          onMouseDown={event => event.preventDefault()}
          onClick={() => onSelect(null)}
        >
          <addIcon.react
            tag="span"
            className="jp-xtralab-AskAgent-targetIcon"
          />
          <span className="jp-xtralab-AskAgent-targetLabel">
            {trans.__('New terminal')}
          </span>
        </button>
      )}
      {targets.map(target => (
        <button
          key={target.name}
          type="button"
          role="radio"
          aria-checked={target.name === targetName}
          tabIndex={target.name === targetName ? 0 : -1}
          title={
            target.activity
              ? trans.__(
                  '%1 · %2 — %3',
                  target.label,
                  target.name,
                  target.activity
                )
              : trans.__('%1 · %2', target.label, target.name)
          }
          className={
            'jp-xtralab-AskAgent-targetButton' +
            (target.name === targetName ? ' jp-mod-selected' : '')
          }
          onMouseDown={event => event.preventDefault()}
          onClick={() => onSelect(target.name)}
        >
          <target.icon.react
            tag="span"
            className="jp-xtralab-AskAgent-targetIcon"
          />
          <span className="jp-xtralab-AskAgent-targetLabel">
            {target.label}
          </span>
          <span className="jp-xtralab-AskAgent-targetName">{target.name}</span>
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
