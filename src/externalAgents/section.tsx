import type { TranslationBundle } from '@jupyterlab/translation';
import {
  LabIcon,
  PanelWithToolbar,
  ReactWidget,
  refreshIcon,
  terminalIcon,
  ToolbarButton,
  UseSignal
} from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import * as React from 'react';

import {
  ATTACH_COMMAND,
  IExternalAgents,
  IExternalAgentSession,
  TRANSCRIPT_COMMAND
} from './tokens';

/**
 * Persisted by the movable-sections plugin — must stay stable across releases.
 */
export const EXTERNAL_AGENTS_SECTION_ID = 'xtralab-external-agents-section';

function statusLabel(
  session: IExternalAgentSession,
  trans: TranslationBundle
): string {
  switch (session.status) {
    case 'busy':
      return trans.__('working');
    case 'idle':
      return trans.__('idle');
    default:
      return trans.__('running');
  }
}

function ExternalAgentsComponent(props: {
  agents: IExternalAgents;
  commands: CommandRegistry;
  iconForAgent: (agent: string) => LabIcon;
  trans: TranslationBundle;
}): JSX.Element {
  const { agents, commands, iconForAgent, trans } = props;
  const sessions = agents.sessions();
  if (sessions.length === 0) {
    return (
      <div className="jp-xtralab-ExternalAgents-body">
        <p className="jp-xtralab-ExternalAgents-empty">
          {trans.__(
            'No coding agent is running outside JupyterLab in this folder.'
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="jp-xtralab-ExternalAgents-body">
      <ul className="jp-xtralab-ExternalAgents-list">
        {sessions.map(session => {
          const RowIcon = iconForAgent(session.agent).react;
          const label = session.title ?? session.name;
          const detail = session.lastPrompt ?? session.subpath ?? session.cwd;
          const openTitle = session.transcript
            ? trans.__('Show the conversation of %1', session.name)
            : trans.__('%1 keeps no readable transcript', session.name);
          return (
            <li key={session.id} className="jp-xtralab-ExternalAgents-item">
              <button
                type="button"
                className="jp-xtralab-ExternalAgents-item-activate"
                disabled={!session.transcript}
                title={openTitle}
                aria-label={openTitle}
                onClick={() =>
                  void commands.execute(TRANSCRIPT_COMMAND, { id: session.id })
                }
              >
                <RowIcon
                  tag="span"
                  className="jp-xtralab-ExternalAgents-item-icon"
                  verticalAlign="middle"
                />
                <span className="jp-xtralab-ExternalAgents-item-text">
                  <span className="jp-xtralab-ExternalAgents-item-label">
                    <span
                      className={`jp-xtralab-ExternalAgents-status jp-mod-${session.status}`}
                      title={statusLabel(session, trans)}
                    />
                    {label}
                  </span>
                  <span className="jp-xtralab-ExternalAgents-item-detail">
                    {detail}
                  </span>
                </span>
              </button>
              {session.attach && (
                <button
                  type="button"
                  className="jp-xtralab-ExternalAgents-item-action"
                  title={trans.__('Attach a terminal: %1', session.attach)}
                  aria-label={trans.__('Attach a terminal to %1', session.name)}
                  onClick={() =>
                    void commands.execute(ATTACH_COMMAND, { id: session.id })
                  }
                >
                  <terminalIcon.react tag="span" verticalAlign="middle" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The body of the External agents section.
 */
class ExternalAgentsListing extends ReactWidget {
  constructor(options: ExternalAgentsSection.IOptions) {
    super();
    this._options = options;
    this.addClass('jp-xtralab-ExternalAgents-listing');
  }

  /**
   * Render the listing, re-rendering on every model change.
   */
  protected render(): React.ReactElement {
    const { agents, commands, iconForAgent, trans } = this._options;
    return (
      <UseSignal signal={agents.changed}>
        {() => (
          <ExternalAgentsComponent
            agents={agents}
            commands={commands}
            iconForAgent={iconForAgent}
            trans={trans}
          />
        )}
      </UseSignal>
    );
  }

  private _options: ExternalAgentsSection.IOptions;
}

/**
 * The "External agents" section of the terminals panel: the coding agents
 * running outside JupyterLab in the open folder, with actions to replay
 * their conversation, send them a prompt or attach a terminal.
 */
export class ExternalAgentsSection extends PanelWithToolbar {
  constructor(options: ExternalAgentsSection.IOptions) {
    super();
    this.id = EXTERNAL_AGENTS_SECTION_ID;
    this.title.label = options.trans.__('External agents');
    this.addClass('jp-xtralab-ExternalAgents-section');
    this.toolbar.addItem(
      'refresh',
      new ToolbarButton({
        icon: refreshIcon,
        onClick: () => void options.agents.refresh(),
        tooltip: options.trans.__('Look again for agents running outside')
      })
    );
    this.addWidget(new ExternalAgentsListing(options));
  }
}

/**
 * A namespace for `ExternalAgentsSection` statics.
 */
export namespace ExternalAgentsSection {
  /**
   * Construction options for {@link ExternalAgentsSection}.
   */
  export interface IOptions {
    /**
     * The sessions model the section renders.
     */
    agents: IExternalAgents;
    /**
     * Command registry the row actions go through.
     */
    commands: CommandRegistry;
    /**
     * Resolve an agent id to its icon; supplied by the terminals plugin so
     * user-configured icons apply here too.
     */
    iconForAgent: (agent: string) => LabIcon;
    /**
     * Translation bundle for the section's labels.
     */
    trans: TranslationBundle;
  }
}
