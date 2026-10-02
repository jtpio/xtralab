import { ChatWidget } from '@jupyter/chat';
import { IThemeManager, MainAreaWidget } from '@jupyterlab/apputils';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { ITranslator, TranslationBundle } from '@jupyterlab/translation';
import {
  LabIcon,
  ReactWidget,
  terminalIcon,
  Toolbar,
  ToolbarButton,
  UseSignal
} from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import type { Message } from '@lumino/messaging';
import * as React from 'react';

import { ExternalSessionChatModel } from './chatModel';
import type { IExternalAgents } from './tokens';

/**
 * Status and folder of the session, on the tab's toolbar.
 */
class StatusItem extends ReactWidget {
  constructor(options: {
    id: string;
    agents: IExternalAgents;
    trans: TranslationBundle;
  }) {
    super();
    this._options = options;
    this.addClass('jp-xtralab-ExternalChat-status');
  }

  protected render(): JSX.Element {
    const { id, agents, trans } = this._options;
    return (
      <UseSignal signal={agents.changed}>
        {() => {
          const session = agents.find(id);
          const status = session?.status ?? 'ended';
          const label =
            status === 'busy'
              ? trans.__('Working')
              : status === 'idle'
                ? trans.__('Idle')
                : status === 'ended'
                  ? trans.__('Ended')
                  : trans.__('Running');
          return (
            <>
              <span
                className={`jp-xtralab-ExternalChat-dot jp-mod-${status}`}
              />
              <span>{label}</span>
              {session && (
                <span
                  className="jp-xtralab-ExternalChat-cwd"
                  title={session.cwd}
                >
                  {session.subpath ?? trans.__('project root')}
                </span>
              )}
            </>
          );
        }}
      </UseSignal>
    );
  }

  private _options: {
    id: string;
    agents: IExternalAgents;
    trans: TranslationBundle;
  };
}

/**
 * Main-area tab showing one external session as a jupyter-chat
 * conversation, with the agent's status and an attach button on the
 * toolbar and the chat input wired to the session's prompt channel.
 */
export class ExternalChatWidget extends MainAreaWidget<ChatWidget> {
  constructor(options: ExternalChatWidget.IOptions) {
    const model = new ExternalSessionChatModel({
      id: options.id,
      agents: options.agents,
      agentLabel: options.agentLabel,
      icon: options.icon,
      trans: options.trans,
      translator: options.translator,
      commands: options.commands
    });
    const chat = new ChatWidget({
      model,
      rmRegistry: options.rmRegistry,
      themeManager: options.themeManager,
      translator: options.translator
    });
    super({ content: chat });
    this._model = model;
    this._agents = options.agents;
    this.id = `xtralab-external-chat-${options.id}`;
    this._label = options.label ?? Private.fallbackLabel(options.id);
    this.addClass('jp-xtralab-ExternalChat');
    this.title.icon = options.icon;
    this.title.closable = true;

    const { id, agents, trans } = options;
    this.toolbar.addItem('status', new StatusItem({ id, agents, trans }));
    this.toolbar.addItem('spacer', Toolbar.createSpacerItem());
    const attach = new ToolbarButton({
      icon: terminalIcon,
      label: trans.__('Attach in terminal'),
      tooltip: trans.__('Open a terminal connected to this session'),
      onClick: () => void agents.attach(id),
      enabled: agents.find(id)?.attach !== null
    });
    this.toolbar.addItem('attach', attach);

    this._syncSession = () => {
      const session = agents.find(id);
      attach.setHidden(session === null || session.attach === null);
      if (session !== null) {
        this._label = session.title ?? session.name;
        this.title.caption = `${session.name} · ${session.cwd}`;
      }
      this.title.label = this._label;
    };
    this._syncSession();
    agents.changed.connect(this._syncSession);
  }

  /**
   * The external session id shown.
   */
  get sessionId(): string {
    return this._model.sessionId;
  }

  /**
   * Dispose of the widget, its model and signal connections.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._agents.changed.disconnect(this._syncSession);
    this._model.dispose();
    super.dispose();
  }

  /**
   * Poll the transcript only while the tab is on screen.
   */
  protected onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    this._model.standby = false;
  }

  protected onAfterHide(msg: Message): void {
    super.onAfterHide(msg);
    this._model.standby = true;
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    this._model.standby = !this.isVisible;
  }

  private _model: ExternalSessionChatModel;
  private _agents: IExternalAgents;
  private _syncSession: () => void;
  private _label: string;
}

/**
 * A namespace for `ExternalChatWidget` statics.
 */
export namespace ExternalChatWidget {
  /**
   * Construction options for {@link ExternalChatWidget}.
   */
  export interface IOptions {
    /**
     * The external session id to show.
     */
    id: string;
    /**
     * Tab label to start with, for a session the poll no longer lists.
     */
    label?: string;
    /**
     * The sessions model, for the live record and the actions.
     */
    agents: IExternalAgents;
    /**
     * Display name of the agent, used as the bot sender's name.
     */
    agentLabel: string;
    /**
     * The agent's icon, for the tab and the bot avatar.
     */
    icon: LabIcon;
    /**
     * The rendermime registry jupyter-chat renders message bodies with.
     */
    rmRegistry: IRenderMimeRegistry;
    /**
     * Theme manager, so jupyter-chat follows the active theme.
     */
    themeManager?: IThemeManager | null;
    /**
     * Translation bundle for the widget's own labels.
     */
    trans: TranslationBundle;
    /**
     * Application translator, forwarded to jupyter-chat.
     */
    translator?: ITranslator;
    /**
     * Command registry, forwarded so the code toolbar can act.
     */
    commands?: CommandRegistry;
  }
}

namespace Private {
  /**
   * `codex 01a0f3a7` for an id like `codex:01a0f3a7-…`.
   */
  export function fallbackLabel(id: string): string {
    const [agent, ...rest] = id.split(':');
    return `${agent} ${rest.join(':').slice(0, 8)}`.trim();
  }
}
