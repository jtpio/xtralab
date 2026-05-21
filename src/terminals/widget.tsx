import {
  type TranslationBundle,
  nullTranslator
} from '@jupyterlab/translation';
import {
  addIcon,
  closeIcon,
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
export const RUNNING_TERMINALS_ID = 'xtralab-running-terminals';

/**
 * Left-sidebar panel listing every running terminal session. It is the
 * sidebar counterpart of the launcher's terminal tiles: where the
 * launcher *starts* sessions, this panel surfaces the ones already
 * running so the user can jump back to a backgrounded agent — including
 * sessions whose tab has been closed but which are still alive on the
 * server.
 *
 * Backed by {@link SessionRegistry}: a `UseSignal` re-renders the list
 * whenever the registry emits `stateChanged`, so it tracks
 * `runningChanged` and the agent-title cache without any local state.
 * Click behaviour (activate vs. reopen, shutdown, new terminal) is
 * delegated to plugin-supplied callbacks so the widget never imports
 * `app`.
 */
export class RunningTerminals extends ReactWidget {
  constructor(options: RunningTerminals.IOptions) {
    super();
    this._registry = options.registry;
    this._trans = options.trans ?? nullTranslator.load('jupyterlab');
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
  private _onActivate: (sessionName: string) => void;
  private _onShutdown: (sessionName: string) => void;
  private _onShutdownAll: () => void;
  private _onCreate: () => void;
}

export namespace RunningTerminals {
  export interface IOptions {
    registry: SessionRegistry;
    trans?: TranslationBundle;
    /**
     * Activate the named session's open tab, or reopen it in a fresh
     * terminal widget if no tab is currently attached.
     */
    onActivate: (sessionName: string) => void;
    /** Shut the named session down on the server. */
    onShutdown: (sessionName: string) => void;
    /**
     * Shut down every running terminal at once. The plugin is expected to
     * confirm with the user first, since it tears down all live sessions.
     */
    onShutdownAll: () => void;
    /** Open a brand-new terminal. */
    onCreate: () => void;
  }
}

function RunningTerminalsComponent(props: {
  registry: SessionRegistry;
  trans: TranslationBundle;
  onActivate: (sessionName: string) => void;
  onShutdown: (sessionName: string) => void;
  onShutdownAll: () => void;
  onCreate: () => void;
}): React.ReactElement {
  const { registry, trans, onActivate, onShutdown, onShutdownAll, onCreate } =
    props;
  const names = registry.sessionNames();

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
            onClick={onCreate}
            title={trans.__('New Terminal')}
            aria-label={trans.__('New Terminal')}
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
            return (
              <li key={name} className="jp-xtralab-Terminals-item">
                <button
                  type="button"
                  className="jp-xtralab-Terminals-item-activate"
                  onClick={() => onActivate(name)}
                  title={tooltip}
                  aria-label={tooltip}
                >
                  <terminalIcon.react tag="span" verticalAlign="middle" />
                  <span className="jp-xtralab-Terminals-item-label">
                    {label}
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
