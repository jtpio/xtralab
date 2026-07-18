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
   * The terminal editor to offer in the "Open" section (Neovim preferred over
   * Vim), or `null` when neither is installed. Resolved by the plugin from the
   * same availability probe that filters the agents.
   */
  editor: IEditor | null;
  /**
   * Shared launch-tag registry. When the editor tile launches, it records the
   * session here so the terminals panel badges it with the editor's logo right
   * away, the same as agent launches do. `null` when the provider plugin is
   * unavailable.
   */
  agentSessions: IAgentSessions | null;
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
  /**
   * The translation bundle used to localize the dashboard's user-facing
   * strings.
   */
  trans: TranslationBundle;
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
    // Open a fresh notebook with no kernel attached — equivalent to clicking
    // "No Kernel" in the Select Kernel dialog. `notebook:create-new` always
    // routes through that dialog when no kernelName is given, so drive the
    // underlying docmanager steps directly and pass `shouldStart: false` to
    // suppress kernel selection. The user picks a kernel from the notebook
    // toolbar when they're ready.
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
      // Match `notebook:create-new`'s post-open marker so the first manual
      // save offers a rename instead of overwriting the auto-generated name.
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
    // An editor is "open a terminal and type its command" — the agent launch
    // minus the prompt — so it shares `launchInTerminal` rather than the native
    // `terminal:create-new` call the tiles above use, and tags the session the
    // same way so the terminals panel badges it with the editor's logo.
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
  // The first prompt-capable agent is what Cmd/Ctrl+Enter fires; the hint
  // text below the textarea names it so the keyboard shortcut target
  // isn't a mystery.
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
 * Launcher agents whose CLI has a clean, non-interactive `mcp add` that takes
 * `<name> -- <command>`. The other agents (Goose, OpenCode, Kiro, Mistral
 * Vibe, Antigravity) register MCP through their own config files or UI, so
 * there is no one-line command to surface for them.
 */
const MCP_ADD_AGENT_IDS = new Set(['claude', 'codex', 'copilot']);

/**
 * The stdio proxy console script that bridges an agent to the MCP server.
 */
const MCP_PROXY_COMMAND = 'jupyter-server-mcp-proxy';

/**
 * Copy `text` to the clipboard via a hidden, selected `<textarea>` and the
 * legacy `execCommand('copy')`. Deprecated, but still the most reliable path
 * under a user gesture when the async Clipboard API is unavailable or blocked
 * (the desktop app's Electron window can deny clipboard writes by policy).
 * Returns whether the copy succeeded.
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
 * A collapsed-by-default hint listing the one-line command that registers
 * xtralab's running Jupyter MCP server with each installed agent that
 * supports `mcp add`. Copy-only: the user runs it in their own terminal,
 * where the server is reachable with no port to configure — the desktop
 * supervisor exports `JUPYTER_SERVER_MCP_URL`, and `pip` installs let the
 * proxy discover the server from its runtime file. Renders nothing when none
 * of those agents are on `$PATH`.
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
    // Prefer the async Clipboard API; fall back to `legacyCopy` when it's
    // missing or rejects (Electron can block it by policy). Flag "Copied" only
    // once a copy actually succeeds.
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
 * The non-agent launch tiles — a plain terminal, a new notebook, and a
 * new console. They sit in a separate section below the agent grid so
 * they don't compete with the AI agents visually, and they're always
 * available regardless of the agent prompt textarea (which doesn't
 * apply to them).
 *
 * A terminal editor (Neovim, else Vim) joins the row when one is installed —
 * it opens in a terminal like the agents do, so it lives here rather than in
 * the agent grid. When neither is on `$PATH`, `editor` is `null` and no tile
 * renders.
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
