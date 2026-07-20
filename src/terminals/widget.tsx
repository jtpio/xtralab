import {
  type TranslationBundle,
  nullTranslator
} from '@jupyterlab/translation';
import {
  addIcon,
  closeIcon,
  LabIcon,
  ReactWidget,
  stopIcon,
  terminalIcon,
  UseSignal
} from '@jupyterlab/ui-components';
import * as React from 'react';

import { SessionRegistry } from './model';

/**
 * Id of the panel widget. Used for layout restoration and as the handle
 * the sidebar visibility toggle would target.
 */
const RUNNING_TERMINALS_ID = 'xtralab-running-terminals';

/**
 * Left-sidebar panel listing every running terminal session. It is the
 * sidebar counterpart of the launcher's terminal tiles: where the
 * launcher *starts* sessions, this panel surfaces the ones already
 * running so the user can jump back to a backgrounded agent — including
 * sessions whose tab has been closed but which are still alive on the
 * server. Each row is labelled with the session's title and, for a session
 * running a coding agent, a smaller line below it showing the agent's latest
 * line of output (from {@link SessionRegistry.activityFor}).
 *
 * Backed by {@link SessionRegistry}: a `UseSignal` re-renders the list
 * whenever the registry emits `stateChanged`, so it tracks
 * `runningChanged` and the agent-title cache without any local state.
 * Click behavior (activate vs. reopen, shutdown, new terminal) is
 * delegated to plugin-supplied callbacks so the widget never imports
 * `app`.
 */
export class RunningTerminals extends ReactWidget {
  constructor(options: RunningTerminals.IOptions) {
    super();
    this._registry = options.registry;
    this._trans = options.trans ?? nullTranslator.load('jupyterlab');
    this._iconForCommand = options.iconForCommand;
    this._onActivate = options.onActivate;
    this._onShutdown = options.onShutdown;
    this._onShutdownAll = options.onShutdownAll;
    this._onCreate = options.onCreate;

    this.id = RUNNING_TERMINALS_ID;
    this.title.icon = terminalIcon;
    this.title.caption = this._trans.__('Running Terminals');
    this.addClass('jp-xtralab-Terminals');
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    // The panel owns the registry, so tear down its upstream
    // subscriptions before the React tree goes away.
    this._registry.dispose();
    super.dispose();
  }

  protected render(): React.ReactElement {
    return (
      <UseSignal signal={this._registry.stateChanged}>
        {() => (
          <RunningTerminalsComponent
            registry={this._registry}
            trans={this._trans}
            iconForCommand={this._iconForCommand}
            onActivate={this._onActivate}
            onShutdown={this._onShutdown}
            onShutdownAll={this._onShutdownAll}
            onCreate={this._onCreate}
          />
        )}
      </UseSignal>
    );
  }

  private _registry: SessionRegistry;
  private _trans: TranslationBundle;
  private _iconForCommand: (command: string | null) => LabIcon;
  private _onActivate: (sessionName: string) => void;
  private _onShutdown: (sessionName: string) => void;
  private _onShutdownAll: () => void;
  private _onCreate: (anchor: { x: number; y: number }) => void;
}

export namespace RunningTerminals {
  export interface IOptions {
    registry: SessionRegistry;
    trans?: TranslationBundle;
    /**
     * Resolve the running-agent command for a row (from
     * `registry.agentCommandFor`) to the icon to show before its label —
     * the agent's logo, or the plain terminal icon. Supplied by the plugin
     * so the widget never imports the agent list.
     */
    iconForCommand: (command: string | null) => LabIcon;
    /**
     * Activate the named session's open tab, or reopen it in a fresh
     * terminal widget if no tab is currently attached.
     */
    onActivate: (sessionName: string) => void;
    /**
     * Shut the named session down on the server.
     */
    onShutdown: (sessionName: string) => void;
    /**
     * Shut down every running terminal at once. The plugin is expected to
     * confirm with the user first, since it tears down all live sessions.
     */
    onShutdownAll: () => void;
    /**
     * Activate the "+" button, anchored at the given viewport coordinates
     * (the bottom-left of the button). The plugin decides what to show
     * there — a menu of agents plus a plain terminal, or just a new
     * terminal when no agents are available — so the panel only reports
     * where the button is and never imports the command/menu machinery.
     */
    onCreate: (anchor: { x: number; y: number }) => void;
  }
}

function RunningTerminalsComponent(props: {
  registry: SessionRegistry;
  trans: TranslationBundle;
  iconForCommand: (command: string | null) => LabIcon;
  onActivate: (sessionName: string) => void;
  onShutdown: (sessionName: string) => void;
  onShutdownAll: () => void;
  onCreate: (anchor: { x: number; y: number }) => void;
}): React.ReactElement {
  const {
    registry,
    trans,
    iconForCommand,
    onActivate,
    onShutdown,
    onShutdownAll,
    onCreate
  } = props;
  const names = registry.sessionNames();
  // The session whose terminal is the current widget in the main area, so its
  // row can be highlighted. `null` when the current tab is a notebook or any
  // other non-terminal widget.
  const currentName = registry.currentSessionName();

  return (
    <div className="jp-xtralab-Terminals-body">
      <div className="jp-xtralab-Terminals-header">
        <h2 className="jp-xtralab-Terminals-title">{trans.__('Terminals')}</h2>
        <div className="jp-xtralab-Terminals-actions">
          <button
            type="button"
            className="jp-xtralab-Terminals-action jp-xtralab-Terminals-shutdown-all"
            onClick={onShutdownAll}
            disabled={names.length === 0}
            title={trans.__('Shut Down All Terminals')}
            aria-label={trans.__('Shut Down All Terminals')}
          >
            <stopIcon.react tag="span" verticalAlign="middle" />
          </button>
          <button
            type="button"
            className="jp-xtralab-Terminals-action jp-xtralab-Terminals-new"
            onClick={event => {
              // Anchor whatever the plugin shows (usually an agent menu) to
              // the button's bottom-left, in viewport coordinates — what
              // `Menu.open(x, y)` expects.
              const rect = event.currentTarget.getBoundingClientRect();
              onCreate({ x: rect.left, y: rect.bottom });
            }}
            title={trans.__('New Terminal')}
            aria-label={trans.__('New Terminal')}
            aria-haspopup="menu"
          >
            <addIcon.react tag="span" verticalAlign="middle" />
          </button>
        </div>
      </div>
      {names.length === 0 ? (
        <p className="jp-xtralab-Terminals-empty">
          {trans.__('No running terminals.')}
        </p>
      ) : (
        <ul className="jp-xtralab-Terminals-list">
          {names.map(name => {
            const label = registry.labelFor(name);
            const hasWidget = registry.widgetFor(name) !== null;
            const tooltip = hasWidget
              ? trans.__('Activate %1', label)
              : trans.__('Reopen %1', label);
            // The running agent's logo (e.g. Claude), or the plain terminal
            // icon when nothing recognised is running in the session.
            const RowIcon = iconForCommand(
              registry.agentCommandFor(name)
            ).react;
            const isCurrent = name === currentName;
            // The latest line of output from the session's agent, shown as a
            // smaller line under the title; `null` for rows with nothing to
            // surface (no agent running, or no open tab to read a live buffer).
            const activity = registry.activityFor(name);
            return (
              <li
                key={name}
                className={
                  isCurrent
                    ? 'jp-xtralab-Terminals-item jp-mod-current'
                    : 'jp-xtralab-Terminals-item'
                }
              >
                <button
                  type="button"
                  className="jp-xtralab-Terminals-item-activate"
                  onClick={() => onActivate(name)}
                  title={tooltip}
                  aria-label={tooltip}
                  aria-current={isCurrent || undefined}
                >
                  <RowIcon
                    tag="span"
                    className="jp-xtralab-Terminals-item-icon"
                    verticalAlign="middle"
                  />
                  <span className="jp-xtralab-Terminals-item-text">
                    <span className="jp-xtralab-Terminals-item-label">
                      {label}
                    </span>
                    {activity ? (
                      <span className="jp-xtralab-Terminals-item-detail">
                        {activity}
                      </span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="jp-xtralab-Terminals-item-close"
                  onClick={() => onShutdown(name)}
                  title={trans.__('Shut down %1', label)}
                  aria-label={trans.__('Shut down %1', label)}
                >
                  <closeIcon.react tag="span" verticalAlign="middle" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
