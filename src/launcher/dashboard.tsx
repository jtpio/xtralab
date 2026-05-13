import * as React from 'react';

import type { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Poll } from '@lumino/polling';
import {
  LabIcon,
  ReactWidget,
  consoleIcon,
  notebookIcon,
  refreshIcon,
  terminalIcon
} from '@jupyterlab/ui-components';
import type { Widget } from '@lumino/widgets';

import { expandStatusFiles, status } from '../git/api';
import {
  CommandIDs as GitCommandIDs,
  CommandArguments as GitCommandArguments
} from '../git/commands';
import type {
  FileChangeStatus,
  IFileChange,
  IGitStatusResult
} from '../git/tokens';

import type { IAgent } from './agents';
import { agentCommandId } from './commands';

/**
 * Public construction options for the launcher dashboard widget. The
 * plugin supplies an `onAgentLaunch` callback that performs the same
 * shell placement the stock JupyterLab launcher does (swap the launcher
 * tab for the freshly created terminal). Keeping it as an opaque
 * callback means the widget itself does not import `app.shell`.
 */
export interface ILauncherDashboardOptions {
  commands: CommandRegistry;
  /**
   * The agent list to render. Already filtered by availability + sorted by
   * rank; the widget renders them as-is.
   */
  agents: IAgent[];
  /**
   * Called after an agent command has returned its top-level widget. The
   * plugin uses this to swap the new terminal into the launcher's tab.
   */
  onAgentLaunch: (item: Widget) => void;
  /**
   * The git server-relative repo path used by the changes section. Empty
   * string means "use the JupyterLab server's root and let git resolve the
   * enclosing repo" — same convention as the git panel.
   */
  repoPath: string;
  /**
   * The cwd forwarded to `terminal:create-new` when an agent is launched.
   * Empty string lets the terminal extension default to the server root.
   */
  cwd: string;
}

/**
 * Lumino host for the React-based launcher dashboard. Mirrors the
 * `ReactWidget` pattern used by the git panel so the rest of the plugin
 * (layout placement, signals, lifecycle) stays consistent.
 */
export class LauncherDashboard extends ReactWidget {
  constructor(options: ILauncherDashboardOptions) {
    super();
    this.addClass('jp-xtralab-Launcher');
    this._options = options;
  }

  protected render(): React.ReactElement {
    return <LauncherDashboardComponent {...this._options} />;
  }

  private _options: ILauncherDashboardOptions;
}

interface IGitState {
  loading: boolean;
  result: IGitStatusResult | null;
  error: string | null;
}

/**
 * Refresh interval for the changes list. A bit slower than the git panel
 * (which sits in the sidebar and is always visible) — the launcher tab is
 * only opened intentionally, and the grid does not need to be live.
 */
const CHANGES_POLL_INTERVAL_MS = 8000;

/**
 * Upper bound on the exponential backoff when the status request fails
 * repeatedly. Matches the rest of the plugin's polls so behavior is
 * consistent across the dashboard, the git panel, and the file tree.
 */
const CHANGES_POLL_MAX_MS = 300_000;

function LauncherDashboardComponent(
  props: ILauncherDashboardOptions
): React.ReactElement {
  const { commands, agents, onAgentLaunch, repoPath, cwd } = props;
  const [prompt, setPrompt] = React.useState('');
  const [git, setGit] = React.useState<IGitState>({
    loading: true,
    result: null,
    error: null
  });

  const refresh = React.useCallback(async () => {
    try {
      const result = await status(repoPath);
      setGit({ loading: false, result, error: null });
    } catch (error) {
      setGit({
        loading: false,
        result: null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, [repoPath]);

  // Driven by a Lumino `Poll` so the dashboard stops hitting the git
  // endpoint while the JupyterLab tab is hidden, and so repeated
  // failures back off exponentially instead of pegging the 8s cadence.
  React.useEffect(() => {
    const poll = new Poll({
      name: '@xtralab/launcher:gitChanges',
      factory: () => refresh(),
      frequency: {
        interval: CHANGES_POLL_INTERVAL_MS,
        backoff: true,
        max: CHANGES_POLL_MAX_MS
      },
      standby: 'when-hidden'
    });
    return () => {
      poll.dispose();
    };
  }, [refresh]);

  const launch = React.useCallback(
    async (agent: IAgent) => {
      const args: Record<string, string> = { cwd };
      const trimmed = prompt.trim();
      if (trimmed.length > 0 && agent.promptArgs !== undefined) {
        args.prompt = trimmed;
      }
      const result = (await commands.execute(
        agentCommandId(agent.id),
        args
      )) as Widget | undefined;
      if (result) {
        onAgentLaunch(result);
      }
    },
    [commands, cwd, prompt, onAgentLaunch]
  );

  const launchTerminal = React.useCallback(async () => {
    const result = (await commands.execute('terminal:create-new', {
      cwd
    })) as Widget | undefined;
    if (result) {
      onAgentLaunch(result);
    }
  }, [commands, cwd, onAgentLaunch]);

  const launchNotebook = React.useCallback(async () => {
    // No `kernelName` — let the notebook extension fall back to the default
    // kernel or prompt the user, matching the stock launcher's notebook
    // tile behavior.
    const result = (await commands.execute('notebook:create-new', {
      cwd
    })) as Widget | undefined;
    if (result) {
      onAgentLaunch(result);
    }
  }, [commands, cwd, onAgentLaunch]);

  const launchConsole = React.useCallback(async () => {
    const result = (await commands.execute('console:create', {
      cwd
    })) as Widget | undefined;
    if (result) {
      onAgentLaunch(result);
    }
  }, [commands, cwd, onAgentLaunch]);

  const openDiff = React.useCallback(
    (change: IFileChange) => {
      const args: GitCommandArguments.IOpenDiff = { repoPath, change };
      void commands.execute(
        GitCommandIDs.openDiff,
        args as unknown as ReadonlyPartialJSONObject
      );
    },
    [commands, repoPath]
  );

  return (
    <div className="jp-xtralab-Launcher-body">
      <AgentSection
        agents={agents}
        prompt={prompt}
        onPromptChange={setPrompt}
        onLaunch={launch}
      />
      <OpenSection
        onLaunchTerminal={launchTerminal}
        onLaunchNotebook={launchNotebook}
        onLaunchConsole={launchConsole}
      />
      <ChangesSection
        git={git}
        onOpen={openDiff}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}

function ChangesSection(props: {
  git: IGitState;
  onOpen: (change: IFileChange) => void;
  onRefresh: () => void;
}): React.ReactElement {
  const { git, onOpen, onRefresh } = props;
  const files = git.result ? expandStatusFiles(git.result.files) : [];

  // Native `<details>` rather than a hand-rolled toggle: we get the
  // disclosure triangle, keyboard handling, and aria-expanded semantics
  // for free, and the user's open/closed choice is tab-local state that
  // we don't need to persist.
  return (
    <details
      className="jp-xtralab-Launcher-section jp-xtralab-Launcher-changes-section"
      open
    >
      <summary className="jp-xtralab-Launcher-section-summary">
        <span className="jp-xtralab-Launcher-section-title">Changes</span>
        {files.length > 0 && (
          <span
            className="jp-xtralab-Launcher-section-count"
            aria-label={`${files.length} changed file${files.length === 1 ? '' : 's'}`}
          >
            {files.length}
          </span>
        )}
        <button
          type="button"
          className="jp-xtralab-Launcher-section-action"
          aria-label="Refresh changes"
          // Stop the click from toggling the surrounding `<details>` —
          // refreshing while the section is open shouldn't collapse it.
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onRefresh();
          }}
        >
          <LabIcon.resolveReact icon={refreshIcon} tag="span" />
        </button>
      </summary>
      <div className="jp-xtralab-Launcher-section-body">
        {git.loading && files.length === 0 && (
          <p className="jp-xtralab-Launcher-empty">Loading…</p>
        )}
        {!git.loading && git.error !== null && (
          <p className="jp-xtralab-Launcher-empty">{git.error}</p>
        )}
        {!git.loading && git.error === null && files.length === 0 && (
          <p className="jp-xtralab-Launcher-empty">No changes.</p>
        )}
        {files.length > 0 && (
          <ul className="jp-xtralab-Launcher-changes">
            {files.map((change, index) => (
              <li key={`${change.group}:${change.path}:${index}`}>
                <button
                  type="button"
                  className="jp-xtralab-Launcher-change"
                  onClick={() => onOpen(change)}
                  title={`Open diff for ${change.path}`}
                >
                  <span
                    className={`jp-xtralab-Launcher-change-badge jp-xtralab-Launcher-change-${change.status}`}
                    aria-hidden="true"
                  >
                    {statusBadge(change.status)}
                  </span>
                  <span className="jp-xtralab-Launcher-change-path">
                    {change.path}
                  </span>
                  <span
                    className="jp-xtralab-Launcher-change-group"
                    aria-hidden="true"
                  >
                    {change.group === 'staged' ? 'staged' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function statusBadge(status: FileChangeStatus): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return 'U';
    case 'unmerged':
      return '!';
    case 'typechange':
      return 'T';
    default:
      return '?';
  }
}

function AgentSection(props: {
  agents: IAgent[];
  prompt: string;
  onPromptChange: (value: string) => void;
  onLaunch: (agent: IAgent) => void;
}): React.ReactElement {
  const { agents, prompt, onPromptChange, onLaunch } = props;
  const trimmed = prompt.trim();
  const promptActive = trimmed.length > 0;
  // The "primary" agent is the first prompt-capable one in the rendered
  // order. We mark it visually so the keyboard shortcut target isn't a
  // mystery, and reuse the same agent when Cmd/Ctrl+Enter fires from the
  // textarea — picking by the same rule keeps the two behaviors in sync.
  const primaryAgent = agents.find(agent => agent.promptArgs !== undefined);
  const hintId = 'jp-xtralab-Launcher-agent-hint';

  return (
    <section className="jp-xtralab-Launcher-section">
      <h2 className="jp-xtralab-Launcher-section-title">Start an agent</h2>
      <textarea
        className="jp-xtralab-Launcher-prompt"
        placeholder="Initial prompt (optional) — passed to the selected agent."
        value={prompt}
        spellCheck={false}
        rows={3}
        onChange={event => onPromptChange(event.target.value)}
        onKeyDown={event => {
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            trimmed.length > 0 &&
            primaryAgent !== undefined
          ) {
            event.preventDefault();
            onLaunch(primaryAgent);
          }
        }}
      />
      <p
        id={hintId}
        className="jp-xtralab-Launcher-agent-hint"
        aria-live="polite"
      >
        {promptActive
          ? `Cmd/Ctrl+Enter launches ${primaryAgent?.label ?? 'the first prompt-capable agent'}. Agents that don't accept an initial prompt are dimmed.`
          : 'Type a prompt to send it to the chosen agent. Some agents only launch without a prompt.'}
      </p>
      <div className="jp-xtralab-Launcher-agents">
        {agents.map(agent => {
          const supportsPrompt = agent.promptArgs !== undefined;
          const disabled = promptActive && !supportsPrompt;
          const isPrimary = agent === primaryAgent;
          const tooltip = disabled
            ? `${agent.label} doesn't accept an initial prompt — clear the prompt to launch.`
            : agent.caption;
          const classes = ['jp-xtralab-Launcher-agent'];
          if (isPrimary) {
            classes.push('jp-xtralab-Launcher-agent-primary');
          }
          return (
            <button
              key={agent.id}
              type="button"
              className={classes.join(' ')}
              title={tooltip}
              aria-label={agent.label}
              aria-describedby={hintId}
              disabled={disabled}
              onClick={() => onLaunch(agent)}
            >
              <LabIcon.resolveReact
                icon={agent.icon}
                tag="span"
                className="jp-xtralab-Launcher-agent-icon"
              />
              <span className="jp-xtralab-Launcher-agent-label">
                {agent.label}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The non-agent launch tiles — a plain terminal, a new notebook, and a
 * new console. They sit in a separate section below the agent grid so
 * they don't compete with the AI agents visually, and they're always
 * available regardless of the agent prompt textarea (which doesn't
 * apply to them).
 */
function OpenSection(props: {
  onLaunchTerminal: () => void;
  onLaunchNotebook: () => void;
  onLaunchConsole: () => void;
}): React.ReactElement {
  const { onLaunchTerminal, onLaunchNotebook, onLaunchConsole } = props;
  return (
    <section className="jp-xtralab-Launcher-section">
      <h2 className="jp-xtralab-Launcher-section-title">Open</h2>
      <div className="jp-xtralab-Launcher-agents">
        <button
          type="button"
          className="jp-xtralab-Launcher-agent"
          title="Open a new terminal."
          aria-label="Open a new terminal"
          onClick={onLaunchTerminal}
        >
          <LabIcon.resolveReact
            icon={terminalIcon}
            tag="span"
            className="jp-xtralab-Launcher-agent-icon"
          />
          <span className="jp-xtralab-Launcher-agent-label">Terminal</span>
        </button>
        <button
          type="button"
          className="jp-xtralab-Launcher-agent"
          title="Create a new notebook."
          aria-label="Create a new notebook"
          onClick={onLaunchNotebook}
        >
          <LabIcon.resolveReact
            icon={notebookIcon}
            tag="span"
            className="jp-xtralab-Launcher-agent-icon"
          />
          <span className="jp-xtralab-Launcher-agent-label">Notebook</span>
        </button>
        <button
          type="button"
          className="jp-xtralab-Launcher-agent"
          title="Create a new console."
          aria-label="Create a new console"
          onClick={onLaunchConsole}
        >
          <LabIcon.resolveReact
            icon={consoleIcon}
            tag="span"
            className="jp-xtralab-Launcher-agent-icon"
          />
          <span className="jp-xtralab-Launcher-agent-label">Console</span>
        </button>
      </div>
    </section>
  );
}
