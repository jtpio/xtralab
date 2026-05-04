import * as React from 'react';

import { ISignal } from '@lumino/signaling';

import {
  add,
  addAll,
  checkout,
  porcelainToFileChanges,
  reset,
  resetAll,
  showTopLevel,
  status
} from './api';
import { FileChangeStatus, IFileChange, IGitStatusResult } from './tokens';

/**
 * Callbacks the panel needs to delegate to (so the React component stays
 * free of any JupyterLab application coupling). The plugin wires these up
 * with the actual `JupyterFrontEnd` reference.
 */
export interface IGitPanelHandlers {
  /** Open a diff viewer for the given file in the main area. */
  openDiff(change: IFileChange): void;
  /** Show a confirmation dialog. Returns true when the user accepted. */
  confirm(title: string, body: string, accept: string): Promise<boolean>;
  /** Show an error dialog. */
  showError(title: string, error: Error): Promise<void>;
}

interface IPanelState {
  /** True while the initial status request is in flight. */
  loading: boolean;
  /** The raw result of the last status call, or `null` if it hasn't completed yet. */
  result: IGitStatusResult | null;
  /** Set when the status request errored or the path is not in a repo. */
  error: string | null;
}

/**
 * The polling interval for the panel. We refresh the status periodically so
 * out-of-band changes (e.g. the user runs `git add` from a terminal) become
 * visible without requiring a manual refresh.
 */
const STATUS_POLL_INTERVAL_MS = 5000;

/**
 * Top-level React component rendered inside the {@link GitPanel} widget.
 * Owns the polling + refresh wiring around the `/git/status` endpoint and
 * the small bit of UI state that controls section collapse and the
 * in-flight per-file action spinners.
 */
export function GitPanelComponent(props: {
  handlers: IGitPanelHandlers;
  refreshSignal: ISignal<unknown, void>;
}): React.ReactElement {
  const { handlers, refreshSignal } = props;

  const [state, setState] = React.useState<IPanelState>({
    loading: true,
    result: null,
    error: null
  });
  // The absolute filesystem path of the resolved git top-level. Used purely
  // for display in the panel header.
  const [topLevel, setTopLevel] = React.useState<string | null>(null);
  // Per-action spinner gating: keyed by `${group}:${path}`, value is the
  // action currently in flight. Lets the row render a disabled state on
  // exactly the file that is being mutated, without locking the whole panel.
  const [pendingActions, setPendingActions] = React.useState<
    Record<string, string>
  >({});
  const [stagedCollapsed, setStagedCollapsed] = React.useState(false);
  const [changesCollapsed, setChangesCollapsed] = React.useState(false);

  // The repo path passed to every API call. We use the JupyterLab server's
  // root (the empty string) and let `git` resolve the enclosing repo on the
  // server side. This works as long as the server was started inside a git
  // repo — the common case.
  const repoPath = '';

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const [topLevelResult, statusResult] = await Promise.all([
        showTopLevel(repoPath),
        status(repoPath)
      ]);
      setTopLevel(topLevelResult);
      if (statusResult.code !== 0) {
        setState({
          loading: false,
          result: null,
          error: statusResult.message ?? 'Failed to load git status'
        });
        return;
      }
      setState({ loading: false, result: statusResult, error: null });
    } catch (err) {
      setState({
        loading: false,
        result: null,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }, [repoPath]);

  // Initial load + polling. `refresh` is stable for a given `repoPath`, so
  // the polling interval is only re-created when the repo path changes.
  React.useEffect(() => {
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      STATUS_POLL_INTERVAL_MS
    );
    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  // External refresh triggers (toolbar button, plugin-level events).
  React.useEffect(() => {
    const handler = (): void => {
      void refresh();
    };
    refreshSignal.connect(handler);
    return () => {
      refreshSignal.disconnect(handler);
    };
  }, [refresh, refreshSignal]);

  const runAction = React.useCallback(
    async (
      change: IFileChange,
      action: string,
      run: () => Promise<void>
    ): Promise<void> => {
      const key = `${change.group}:${change.path}`;
      setPendingActions(prev => ({ ...prev, [key]: action }));
      try {
        await run();
        await refresh();
      } catch (err) {
        await handlers.showError(
          'Git operation failed',
          err instanceof Error ? err : new Error(String(err))
        );
      } finally {
        setPendingActions(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [handlers, refresh]
  );

  const onStage = React.useCallback(
    (change: IFileChange) =>
      runAction(change, 'stage', () => add(repoPath, change.path)),
    [repoPath, runAction]
  );

  const onUnstage = React.useCallback(
    (change: IFileChange) =>
      runAction(change, 'unstage', () => reset(repoPath, change.path)),
    [repoPath, runAction]
  );

  const onDiscard = React.useCallback(
    async (change: IFileChange): Promise<void> => {
      const verb = change.status === 'untracked' ? 'remove' : 'restore';
      const accepted = await handlers.confirm(
        verb === 'remove' ? 'Remove file' : 'Discard changes',
        verb === 'remove'
          ? `Permanently remove ${change.path}? This cannot be undone.`
          : `Discard all changes to ${change.path}? This will revert the file to its last staged version and cannot be undone.`,
        verb === 'remove' ? 'Remove' : 'Discard'
      );
      if (!accepted) {
        return;
      }
      // The git extension's `checkout` endpoint without a branch reverts the
      // working tree copy of the file to the index. For untracked files we
      // can't checkout, so the user is told the action is unsupported and we
      // bail out — they can delete the file via the file browser instead.
      if (change.status === 'untracked') {
        await handlers.showError(
          'Cannot discard untracked file',
          new Error(
            'Untracked files cannot be discarded from the git panel — delete them from the file browser instead.'
          )
        );
        return;
      }
      await runAction(change, 'discard', () => checkout(repoPath, change.path));
    },
    [handlers, repoPath, runAction]
  );

  const onStageAll = React.useCallback(async (): Promise<void> => {
    try {
      await addAll(repoPath);
      await refresh();
    } catch (err) {
      await handlers.showError(
        'Stage all failed',
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }, [handlers, refresh, repoPath]);

  const onUnstageAll = React.useCallback(async (): Promise<void> => {
    try {
      await resetAll(repoPath);
      await refresh();
    } catch (err) {
      await handlers.showError(
        'Unstage all failed',
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }, [handlers, refresh, repoPath]);

  // Categorize the porcelain entries into the two visible groups. Because
  // `porcelainToFileChanges` may emit two changes per file (one staged, one
  // unstaged), the same file can show up in both lists when it has been
  // partially staged.
  const { staged, unstaged } = React.useMemo(() => {
    const stagedAcc: IFileChange[] = [];
    const unstagedAcc: IFileChange[] = [];
    if (state.result === null) {
      return { staged: stagedAcc, unstaged: unstagedAcc };
    }
    for (const file of state.result.files) {
      for (const change of porcelainToFileChanges(file)) {
        if (change.group === 'staged') {
          stagedAcc.push(change);
        } else {
          unstagedAcc.push(change);
        }
      }
    }
    stagedAcc.sort((a, b) => a.path.localeCompare(b.path));
    unstagedAcc.sort((a, b) => a.path.localeCompare(b.path));
    return { staged: stagedAcc, unstaged: unstagedAcc };
  }, [state.result]);

  return (
    <div className="jp-xtralab-GitPanel-content">
      <PanelHeader
        topLevel={topLevel}
        result={state.result}
        loading={state.loading}
        error={state.error}
        onRefresh={() => void refresh()}
      />
      {state.error !== null ? (
        <div className="jp-xtralab-GitPanel-error">{state.error}</div>
      ) : (
        <>
          <ChangeSection
            label="Staged Changes"
            count={staged.length}
            collapsed={stagedCollapsed}
            onToggleCollapsed={() => setStagedCollapsed(c => !c)}
            actions={
              staged.length > 0
                ? [
                    {
                      label: 'Unstage all changes',
                      symbol: '−',
                      onClick: onUnstageAll
                    }
                  ]
                : undefined
            }
          >
            {staged.map(change => (
              <ChangeRow
                key={`${change.group}:${change.path}`}
                change={change}
                pendingAction={pendingActions[`${change.group}:${change.path}`]}
                onClick={() => handlers.openDiff(change)}
                actions={[
                  {
                    label: 'Unstage changes',
                    symbol: '−',
                    onClick: () => void onUnstage(change)
                  }
                ]}
              />
            ))}
          </ChangeSection>
          <ChangeSection
            label="Changes"
            count={unstaged.length}
            collapsed={changesCollapsed}
            onToggleCollapsed={() => setChangesCollapsed(c => !c)}
            actions={
              unstaged.length > 0
                ? [
                    {
                      label: 'Stage all changes',
                      symbol: '+',
                      onClick: onStageAll
                    }
                  ]
                : undefined
            }
          >
            {unstaged.map(change => (
              <ChangeRow
                key={`${change.group}:${change.path}`}
                change={change}
                pendingAction={pendingActions[`${change.group}:${change.path}`]}
                onClick={() => handlers.openDiff(change)}
                actions={[
                  {
                    label: 'Discard changes',
                    symbol: '⟲',
                    onClick: () => void onDiscard(change)
                  },
                  {
                    label: 'Stage changes',
                    symbol: '+',
                    onClick: () => void onStage(change)
                  }
                ]}
              />
            ))}
          </ChangeSection>
          {staged.length === 0 && unstaged.length === 0 && !state.loading ? (
            <div className="jp-xtralab-GitPanel-empty">
              No changes detected.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

interface IRowAction {
  label: string;
  symbol: string;
  onClick: () => void;
}

function PanelHeader(props: {
  topLevel: string | null;
  result: IGitStatusResult | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): React.ReactElement {
  const { topLevel, result, loading, error, onRefresh } = props;
  const repoName =
    topLevel !== null
      ? (topLevel
          .split('/')
          .filter(s => s.length > 0)
          .pop() ?? topLevel)
      : null;
  return (
    <div className="jp-xtralab-GitPanel-header">
      <div className="jp-xtralab-GitPanel-headerInfo">
        <div className="jp-xtralab-GitPanel-title">Source Control</div>
        {repoName !== null ? (
          <div
            className="jp-xtralab-GitPanel-repo"
            title={topLevel ?? ''}
          >
            {repoName}
          </div>
        ) : null}
        {result?.branch !== undefined && result?.branch !== null ? (
          <div className="jp-xtralab-GitPanel-branch">
            {result.branch}
            {result.ahead > 0 ? <span> ↑{result.ahead}</span> : null}
            {result.behind > 0 ? <span> ↓{result.behind}</span> : null}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="jp-xtralab-GitPanel-iconButton"
        title="Refresh"
        disabled={loading && error === null}
        onClick={onRefresh}
      >
        ⟳
      </button>
    </div>
  );
}

function ChangeSection(props: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  actions?: IRowAction[];
  children: React.ReactNode;
}): React.ReactElement {
  const { label, count, collapsed, onToggleCollapsed, actions, children } =
    props;
  return (
    <div className="jp-xtralab-GitPanel-section">
      <div
        className="jp-xtralab-GitPanel-sectionHeader"
        onClick={onToggleCollapsed}
      >
        <span className="jp-xtralab-GitPanel-sectionChevron">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="jp-xtralab-GitPanel-sectionLabel">
          {label}
        </span>
        {actions !== undefined ? (
          <span className="jp-xtralab-GitPanel-sectionActions">
            {actions.map(action => (
              <button
                key={action.label}
                type="button"
                className="jp-xtralab-GitPanel-iconButton"
                title={action.label}
                onClick={event => {
                  event.stopPropagation();
                  action.onClick();
                }}
              >
                {action.symbol}
              </button>
            ))}
          </span>
        ) : null}
        <span className="jp-xtralab-GitPanel-sectionCount">
          {count}
        </span>
      </div>
      {!collapsed ? (
        <div className="jp-xtralab-GitPanel-sectionBody">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function ChangeRow(props: {
  change: IFileChange;
  pendingAction: string | undefined;
  onClick: () => void;
  actions: IRowAction[];
}): React.ReactElement {
  const { change, pendingAction, onClick, actions } = props;
  const filename = basename(change.path);
  const dirname = dirnameOrEmpty(change.path);
  return (
    <div
      className="jp-xtralab-GitPanel-row"
      data-status={change.status}
      title={
        change.from !== undefined
          ? `${change.from} → ${change.path}`
          : change.path
      }
      onClick={onClick}
    >
      <span className="jp-xtralab-GitPanel-rowLabel">
        <span className="jp-xtralab-GitPanel-rowName">{filename}</span>
        {dirname !== '' ? (
          <span className="jp-xtralab-GitPanel-rowPath">{dirname}</span>
        ) : null}
      </span>
      <span
        className="jp-xtralab-GitPanel-rowActions"
        data-pending={pendingAction !== undefined}
      >
        {actions.map(action => (
          <button
            key={action.label}
            type="button"
            className="jp-xtralab-GitPanel-iconButton"
            title={action.label}
            disabled={pendingAction !== undefined}
            onClick={event => {
              event.stopPropagation();
              action.onClick();
            }}
          >
            {action.symbol}
          </button>
        ))}
      </span>
      <span
        className="jp-xtralab-GitPanel-rowBadge"
        data-status={change.status}
        title={statusTooltip(change.status)}
      >
        {statusBadge(change.status)}
      </span>
    </div>
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

function statusTooltip(status: FileChangeStatus): string {
  switch (status) {
    case 'modified':
      return 'Modified';
    case 'added':
      return 'Added';
    case 'deleted':
      return 'Deleted';
    case 'renamed':
      return 'Renamed';
    case 'untracked':
      return 'Untracked';
    case 'unmerged':
      return 'Unmerged (conflict)';
    case 'typechange':
      return 'Type changed';
    default:
      return 'Unknown';
  }
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}

function dirnameOrEmpty(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}
