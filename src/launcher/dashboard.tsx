import * as React from 'react';

import type { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Poll } from '@lumino/polling';
import type { IDocumentWidget } from '@jupyterlab/docregistry';
import type { TranslationBundle } from '@jupyterlab/translation';
import {
  LabIcon,
  ReactWidget,
  consoleIcon,
  notebookIcon,
  refreshIcon,
  terminalIcon
} from '@jupyterlab/ui-components';
import type { Widget } from '@lumino/widgets';

import type { IAgentSessions } from '../agentSessions';
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
import { launchInTerminal } from './commands';
import type { IEditor } from './editors';
import { agentCommandId } from './tokens';

/**
 * Construction options for the launcher dashboard. `onAgentLaunch` is an
 * opaque callback so the widget itself never imports `app.shell`.
 */
interface ILauncherDashboardOptions {
  /**
   * The application command registry, used to launch terminals and run git
   * commands.
   */
  commands: CommandRegistry;
  /**
   * Agent list to render, already filtered by availability and sorted by rank.
   */
  agents: IAgent[];
  /**
   * Terminal editor for the "Open" section, or `null` when none is installed.
   */
  editor: IEditor | null;
  /**
   * Launch-tag registry so the terminals panel badges editor launches right
   * away; `null` when the provider plugin is unavailable.
   */
  agentSessions: IAgentSessions | null;
  /**
   * Called with the launched widget; the plugin swaps it into the launcher's tab.
   */
  onAgentLaunch: (item: Widget) => void;
  /**
   * Repo path for the changes section. Empty string lets git resolve the
   * enclosing repo from the server root — same convention as the git panel.
   */
  repoPath: string;
  /**
   * Cwd forwarded to `terminal:create-new`. Empty string defaults to the
   * server root.
   */
  cwd: string;
  /**
   * The translation bundle used to localize the dashboard's user-facing
   * strings.
   */
  trans: TranslationBundle;
}

/**
 * Lumino host for the React-based launcher dashboard.
 */
export class LauncherDashboard extends ReactWidget {
  constructor(options: ILauncherDashboardOptions) {
    super();
    this.addClass('jp-xtralab-Launcher');
    this._options = options;
  }

  /**
   * Render the launcher dashboard component.
   */
  protected render(): React.ReactElement {
    return <LauncherDashboardComponent {...this._options} />;
  }

  private _options: ILauncherDashboardOptions;
}

/**
 * State of the changes-section git status fetch.
 */
interface IGitState {
  /**
   * Whether the initial status fetch is still pending.
   */
  loading: boolean;
  /**
   * The latest status result, or `null` before the first success or after a
   * failure.
   */
  result: IGitStatusResult | null;
  /**
   * The latest fetch error message, or `null` when the last fetch succeeded.
   */
  error: string | null;
}

/**
 * Changes-list refresh interval; slower than the git panel since the launcher
 * tab is only opened intentionally.
 */
const CHANGES_POLL_INTERVAL_MS = 8000;

const CHANGES_POLL_MAX_MS = 300_000;

function LauncherDashboardComponent(
  props: ILauncherDashboardOptions
): React.ReactElement {
  const {
    commands,
    agents,
    editor,
    agentSessions,
    onAgentLaunch,
    repoPath,
    cwd,
    trans
  } = props;
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
    // `notebook:create-new` always opens the Select Kernel dialog when no
    // kernelName is given, so drive docmanager directly with `shouldStart: false`.
    const file = (await commands.execute('docmanager:new-untitled', {
      path: cwd,
      type: 'notebook'
    })) as { path: string } | undefined;
    if (!file) {
      return;
    }
    const result = (await commands.execute('docmanager:open', {
      path: file.path,
      factory: 'Notebook',
      kernelPreference: { shouldStart: false, canStart: true }
    })) as IDocumentWidget | undefined;
    if (result) {
      // Match `notebook:create-new`'s marker so the first save offers a rename.
      result.isUntitled = true;
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

  const launchEditor = React.useCallback(async () => {
    if (!editor) {
      return;
    }
    const result = await launchInTerminal(commands, {
      cwd,
      invocation: editor.command,
      label: editor.label,
      onSession: name => agentSessions?.set(name, editor.command)
    });
    onAgentLaunch(result);
  }, [commands, cwd, editor, agentSessions, onAgentLaunch]);

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
        trans={trans}
      />
      <McpSection agents={agents} trans={trans} />
      <OpenSection
        editor={editor}
        onLaunchTerminal={launchTerminal}
        onLaunchNotebook={launchNotebook}
        onLaunchConsole={launchConsole}
        onLaunchEditor={launchEditor}
        trans={trans}
      />
      <ChangesSection
        git={git}
        onOpen={openDiff}
        onRefresh={() => void refresh()}
        trans={trans}
      />
    </div>
  );
}

function ChangesSection(props: {
  git: IGitState;
  onOpen: (change: IFileChange) => void;
  onRefresh: () => void;
  trans: TranslationBundle;
}): React.ReactElement {
  const { git, onOpen, onRefresh, trans } = props;
  const files = git.result ? expandStatusFiles(git.result.files) : [];

  return (
    <details
      className="jp-xtralab-Launcher-section jp-xtralab-Launcher-changes-section"
      open
    >
      <summary className="jp-xtralab-Launcher-section-summary">
        <span className="jp-xtralab-Launcher-section-title">
          {trans.__('Changes')}
        </span>
        {files.length > 0 && (
          <span
            className="jp-xtralab-Launcher-section-count"
            aria-label={trans._n(
              '%1 changed file',
              '%1 changed files',
              files.length
            )}
          >
            {files.length}
          </span>
        )}
        <button
          type="button"
          className="jp-xtralab-Launcher-section-action"
          aria-label={trans.__('Refresh changes')}
          // Keep the click from toggling the surrounding `<details>`.
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
          <p className="jp-xtralab-Launcher-empty">{trans.__('Loading…')}</p>
        )}
        {!git.loading && git.error !== null && (
          <p className="jp-xtralab-Launcher-empty">{git.error}</p>
        )}
        {!git.loading && git.error === null && files.length === 0 && (
          <p className="jp-xtralab-Launcher-empty">{trans.__('No changes.')}</p>
        )}
        {files.length > 0 && (
          <ul className="jp-xtralab-Launcher-changes">
            {files.map((change, index) => (
              <li key={`${change.group}:${change.path}:${index}`}>
                <button
                  type="button"
                  className="jp-xtralab-Launcher-change"
                  onClick={() => onOpen(change)}
                  title={trans.__('Open diff for %1', change.path)}
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
                    {change.group === 'staged' ? trans.__('staged') : ''}
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
  trans: TranslationBundle;
}): React.ReactElement {
  const { agents, prompt, onPromptChange, onLaunch, trans } = props;
  const trimmed = prompt.trim();
  const promptActive = trimmed.length > 0;
  const primaryAgent = agents.find(agent => agent.promptArgs !== undefined);
  const hintId = 'jp-xtralab-Launcher-agent-hint';

  return (
    <section className="jp-xtralab-Launcher-section">
      <h2 className="jp-xtralab-Launcher-section-title">
        {trans.__('Start an agent')}
      </h2>
      <textarea
        className="jp-xtralab-Launcher-prompt"
        placeholder={trans.__(
          'Initial prompt (optional) — passed to the selected agent.'
        )}
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
          ? trans.__(
              "Cmd/Ctrl+Enter launches %1. Agents that don't accept an initial prompt are dimmed.",
              primaryAgent?.label ?? trans.__('the first prompt-capable agent')
            )
          : trans.__(
              'Type a prompt to send it to the chosen agent. Some agents only launch without a prompt.'
            )}
      </p>
      <div className="jp-xtralab-Launcher-agents">
        {agents.map(agent => {
          const supportsPrompt = agent.promptArgs !== undefined;
          const disabled = promptActive && !supportsPrompt;
          const tooltip = disabled
            ? trans.__(
                "%1 doesn't accept an initial prompt — clear the prompt to launch.",
                agent.label
              )
            : agent.caption;
          return (
            <button
              key={agent.id}
              type="button"
              className="jp-xtralab-Launcher-agent"
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
 * Agents whose CLI has a non-interactive `mcp add <name> -- <command>`; the
 * other agents register MCP through their own config, so no one-liner exists.
 */
const MCP_ADD_AGENT_IDS = new Set(['claude', 'codex', 'copilot']);

const MCP_PROXY_COMMAND = 'jupyter-server-mcp-proxy';

/**
 * Copy via a hidden `<textarea>` and the legacy `execCommand('copy')`:
 * deprecated, but the reliable fallback when the async Clipboard API is
 * missing or blocked (Electron can deny it by policy). Returns success.
 */
function legacyCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Collapsed-by-default hint listing the `mcp add` one-liner per installed
 * agent. Copy-only: run in the user's own terminal, where the proxy finds the
 * server with no port (desktop exports `JUPYTER_SERVER_MCP_URL`; pip installs
 * discover it from the runtime file). Renders nothing when no agent qualifies.
 */
function McpSection(props: {
  agents: IAgent[];
  trans: TranslationBundle;
}): React.ReactElement | null {
  const { trans } = props;
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const registerable = props.agents.filter(agent =>
    MCP_ADD_AGENT_IDS.has(agent.id)
  );
  if (registerable.length === 0) {
    return null;
  }

  const flagCopied = (id: string): void => {
    setCopiedId(id);
    window.setTimeout(
      () => setCopiedId(current => (current === id ? null : current)),
      1500
    );
  };

  const copy = (command: string, id: string): void => {
    const clipboard = navigator.clipboard;
    if (clipboard) {
      void clipboard.writeText(command).then(
        () => flagCopied(id),
        () => {
          if (legacyCopy(command)) {
            flagCopied(id);
          }
        }
      );
    } else if (legacyCopy(command)) {
      flagCopied(id);
    }
  };

  return (
    <details className="jp-xtralab-Launcher-section jp-xtralab-Launcher-mcp-section">
      <summary className="jp-xtralab-Launcher-section-summary">
        <span className="jp-xtralab-Launcher-section-title">
          {trans.__('Connect agents to JupyterLab (MCP)')}
        </span>
      </summary>
      <div className="jp-xtralab-Launcher-section-body">
        <p className="jp-xtralab-Launcher-agent-hint">
          {trans.__(
            'Run once per agent to let it drive this JupyterLab over MCP. No port needed — the proxy finds this server on its own.'
          )}
        </p>
        <ul className="jp-xtralab-Launcher-mcp-list">
          {registerable.map(agent => {
            const command = `${agent.command} mcp add jupyter -- ${MCP_PROXY_COMMAND}`;
            return (
              <li key={agent.id} className="jp-xtralab-Launcher-mcp-item">
                <code className="jp-xtralab-Launcher-mcp-command">
                  {command}
                </code>
                <button
                  type="button"
                  className={
                    copiedId === agent.id
                      ? 'jp-xtralab-Launcher-mcp-copy jp-mod-copied'
                      : 'jp-xtralab-Launcher-mcp-copy'
                  }
                  aria-label={trans.__('Copy the %1 command', agent.label)}
                  onClick={() => copy(command, agent.id)}
                >
                  {copiedId === agent.id
                    ? trans.__('Copied!')
                    : trans.__('Copy')}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="jp-xtralab-Launcher-mcp-note">
          {trans.__(
            'Other agents (Goose, OpenCode, Kiro, Mistral Vibe, Antigravity) register MCP through their own config — point them at the same'
          )}{' '}
          <code>{MCP_PROXY_COMMAND}</code> {trans.__('command.')}
        </p>
      </div>
    </details>
  );
}

/**
 * The non-agent launch tiles: terminal, notebook, and console, plus the
 * terminal editor tile when one is installed (`editor` is `null` otherwise).
 */
function OpenSection(props: {
  editor: IEditor | null;
  onLaunchTerminal: () => void;
  onLaunchNotebook: () => void;
  onLaunchConsole: () => void;
  onLaunchEditor: () => void;
  trans: TranslationBundle;
}): React.ReactElement {
  const {
    editor,
    onLaunchTerminal,
    onLaunchNotebook,
    onLaunchConsole,
    onLaunchEditor,
    trans
  } = props;
  return (
    <section className="jp-xtralab-Launcher-section">
      <h2 className="jp-xtralab-Launcher-section-title">{trans.__('Open')}</h2>
      <div className="jp-xtralab-Launcher-agents">
        <button
          type="button"
          className="jp-xtralab-Launcher-agent"
          title={trans.__('Open a new terminal.')}
          aria-label={trans.__('Open a new terminal')}
          onClick={onLaunchTerminal}
        >
          <LabIcon.resolveReact
            icon={terminalIcon}
            tag="span"
            className="jp-xtralab-Launcher-agent-icon"
          />
          <span className="jp-xtralab-Launcher-agent-label">
            {trans.__('Terminal')}
          </span>
        </button>
        <button
          type="button"
          className="jp-xtralab-Launcher-agent"
          title={trans.__('Create a new notebook.')}
          aria-label={trans.__('Create a new notebook')}
          onClick={onLaunchNotebook}
        >
          <LabIcon.resolveReact
            icon={notebookIcon}
            tag="span"
            className="jp-xtralab-Launcher-agent-icon"
          />
          <span className="jp-xtralab-Launcher-agent-label">
            {trans.__('Notebook')}
          </span>
        </button>
        <button
          type="button"
          className="jp-xtralab-Launcher-agent"
          title={trans.__('Create a new console.')}
          aria-label={trans.__('Create a new console')}
          onClick={onLaunchConsole}
        >
          <LabIcon.resolveReact
            icon={consoleIcon}
            tag="span"
            className="jp-xtralab-Launcher-agent-icon"
          />
          <span className="jp-xtralab-Launcher-agent-label">
            {trans.__('Console')}
          </span>
        </button>
        {editor && (
          <button
            type="button"
            className="jp-xtralab-Launcher-agent"
            title={editor.caption}
            aria-label={editor.caption}
            onClick={onLaunchEditor}
          >
            <LabIcon.resolveReact
              icon={editor.icon}
              tag="span"
              className="jp-xtralab-Launcher-agent-icon"
            />
            <span className="jp-xtralab-Launcher-agent-label">
              {editor.label}
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
