import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  IThemeManager,
  Notification,
  WidgetTracker
} from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { LabIcon, terminalIcon } from '@jupyterlab/ui-components';
import { ISignal, Signal } from '@lumino/signaling';
import { IComponentsRendererFactory } from 'jupyter-chat-components';

import { launchInTerminal } from '../launcher/commands';
import { BUILTIN_AGENT_ICONS } from '../launcher/icons';
import { IAgentRegistry } from '../launcher/tokens';

import { postPrompt } from './api';
import { ExternalChatWidget } from './chatWidget';
import { ExternalAgentsModel } from './model';
import {
  ATTACH_COMMAND,
  IExternalAgents,
  IExternalAgentSession,
  TRANSCRIPT_COMMAND
} from './tokens';

const PLUGIN_ID = 'xtralab:external-agents';

const TRACKER_NAMESPACE = 'xtralab-external-agent-transcript';

/**
 * Sender names for agents the launcher hides (not on PATH here).
 */
const BUILTIN_AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'pi'
};

/**
 * The {@link IExternalAgents} implementation: the polled model plus the
 * three actions, each of which routes through the app.
 */
class ExternalAgents implements IExternalAgents {
  constructor(options: {
    model: ExternalAgentsModel;
    app: JupyterFrontEnd;
    tracker: WidgetTracker<ExternalChatWidget>;
    iconForAgent: (agent: string) => LabIcon;
    labelForAgent: (agent: string) => string;
    rmRegistry: IRenderMimeRegistry;
    themeManager: IThemeManager | null;
    translator: ITranslator;
    trans: ReturnType<ITranslator['load']>;
  }) {
    this._model = options.model;
    this._app = options.app;
    this._tracker = options.tracker;
    this._iconForAgent = options.iconForAgent;
    this._labelForAgent = options.labelForAgent;
    this._rmRegistry = options.rmRegistry;
    this._themeManager = options.themeManager;
    this._translator = options.translator;
    this._trans = options.trans;
    this._model.changed.connect(() => this._changed.emit());
  }

  /**
   * Snapshot of the sessions the last poll reported.
   */
  sessions(): IExternalAgentSession[] {
    return this._model.sessions();
  }

  /**
   * The session with this id, or `null`.
   */
  find(id: string): IExternalAgentSession | null {
    return this._model.find(id);
  }

  /**
   * Emitted whenever the snapshot changed.
   */
  get changed(): ISignal<IExternalAgents, void> {
    return this._changed;
  }

  /**
   * Poll now.
   */
  refresh(): Promise<void> {
    return this._model.refresh();
  }

  /**
   * Deliver a prompt, then re-poll so the row's status catches up.
   */
  async sendPrompt(id: string, prompt: string): Promise<void> {
    await postPrompt(id, prompt);
    void this._model.refresh();
  }

  /**
   * Open the transcript tab for the session, or activate the open one.
   */
  async openTranscript(id: string, label?: string): Promise<void> {
    const existing = this._tracker.find(widget => widget.sessionId === id);
    if (existing) {
      this._app.shell.activateById(existing.id);
      return;
    }
    const agent = this._model.find(id)?.agent ?? id.split(':')[0];
    const widget = new ExternalChatWidget({
      id,
      label,
      agents: this,
      agentLabel: this._labelForAgent(agent),
      icon: this._iconForAgent(agent),
      rmRegistry: this._rmRegistry,
      themeManager: this._themeManager,
      trans: this._trans,
      translator: this._translator,
      commands: this._app.commands
    });
    await this._tracker.add(widget);
    this._app.shell.add(widget, 'main');
    this._app.shell.activateById(widget.id);
  }

  /**
   * Open a terminal in the session's folder running its attach command.
   */
  async attach(id: string): Promise<void> {
    const session = this._model.find(id);
    if (session === null || session.attach === null) {
      Notification.warning(
        this._trans.__('This session cannot be attached to.'),
        { autoClose: 3000 }
      );
      return;
    }
    await launchInTerminal(this._app.commands, {
      cwd: session.subpath ?? undefined,
      invocation: session.attach,
      label: session.title ?? session.name
    });
  }

  private _model: ExternalAgentsModel;
  private _app: JupyterFrontEnd;
  private _tracker: WidgetTracker<ExternalChatWidget>;
  private _iconForAgent: (agent: string) => LabIcon;
  private _labelForAgent: (agent: string) => string;
  private _rmRegistry: IRenderMimeRegistry;
  private _themeManager: IThemeManager | null;
  private _translator: ITranslator;
  private _trans: ReturnType<ITranslator['load']>;
  private _changed = new Signal<IExternalAgents, void>(this);
}

/**
 * Coding agents started outside JupyterLab in the open folder: polls the
 * server for them, replays their transcripts in main-area tabs and delivers
 * prompts to the ones that accept them. The terminals panel lists them and
 * ask-agent offers them as targets, both through {@link IExternalAgents}.
 */
const plugin: JupyterFrontEndPlugin<IExternalAgents> = {
  id: PLUGIN_ID,
  description:
    'Lists the coding agents running outside JupyterLab in the open folder, replays their conversations and sends them prompts.',
  autoStart: true,
  provides: IExternalAgents,
  requires: [IRenderMimeRegistry],
  optional: [
    ILayoutRestorer,
    ITranslator,
    IAgentRegistry,
    ICommandPalette,
    IThemeManager,
    IComponentsRendererFactory
  ],
  activate: (
    app: JupyterFrontEnd,
    rmRegistry: IRenderMimeRegistry,
    restorer: ILayoutRestorer | null,
    translator: ITranslator | null,
    agentRegistry: IAgentRegistry | null,
    palette: ICommandPalette | null,
    themeManager: IThemeManager | null,
    chatComponents: IComponentsRendererFactory | null
  ): IExternalAgents => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    // Tool call rows name files server-relative; a click opens them. Another
    // consumer (e.g. the ACP client) may have wired the same callback already.
    if (
      chatComponents &&
      !chatComponents.groupedToolCallCallbacks?.openToolCallPath
    ) {
      chatComponents.groupedToolCallCallbacks = {
        ...chatComponents.groupedToolCallCallbacks,
        openToolCallPath: path => {
          if (path.startsWith('/')) {
            return;
          }
          app.commands.execute('docmanager:open', { path }).catch(error => {
            console.error(`xtralab: failed to open ${path}`, error);
          });
        }
      };
    }
    const model = new ExternalAgentsModel();
    const tracker = new WidgetTracker<ExternalChatWidget>({
      namespace: TRACKER_NAMESPACE
    });

    // The launcher's registry carries user-configured icons; the built-in
    // map covers agents the launcher hides (e.g. not on PATH here).
    const iconForAgent = (agent: string): LabIcon =>
      agentRegistry?.agents.find(a => a.id === agent)?.icon ??
      BUILTIN_AGENT_ICONS[agent] ??
      terminalIcon;

    const labelForAgent = (agent: string): string =>
      agentRegistry?.agents.find(a => a.id === agent)?.label ??
      BUILTIN_AGENT_LABELS[agent] ??
      agent;

    const agents = new ExternalAgents({
      model,
      app,
      tracker,
      iconForAgent,
      labelForAgent,
      rmRegistry,
      themeManager,
      translator: translator ?? nullTranslator,
      trans
    });

    const sessionArg = (args: Record<string, unknown>): string | null =>
      typeof args['id'] === 'string' && args['id'] ? args['id'] : null;

    app.commands.addCommand(TRANSCRIPT_COMMAND, {
      label: args =>
        typeof args['label'] === 'string'
          ? trans.__('Show Conversation: %1', args['label'])
          : trans.__('Show External Agent Conversation'),
      caption: trans.__(
        'Replay the conversation of a coding agent running outside JupyterLab'
      ),
      execute: args => {
        const id = sessionArg(args);
        if (id !== null) {
          const label = args['label'];
          return agents.openTranscript(
            id,
            typeof label === 'string' ? label : undefined
          );
        }
      }
    });

    app.commands.addCommand(ATTACH_COMMAND, {
      label: trans.__('Attach a Terminal to an External Agent'),
      icon: terminalIcon,
      execute: args => {
        const id = sessionArg(args);
        if (id !== null) {
          return agents.attach(id);
        }
      }
    });

    if (restorer) {
      void restorer.restore(tracker, {
        command: TRANSCRIPT_COMMAND,
        args: widget => ({ id: widget.sessionId, label: widget.title.label }),
        name: widget => widget.sessionId
      });
    }

    if (palette) {
      // Palette entries need an id; offer one per running session.
      const category = trans.__('Terminal');
      let disposables: { dispose(): void }[] = [];
      const syncPalette = (): void => {
        for (const item of disposables) {
          item.dispose();
        }
        disposables = [];
        for (const session of model.sessions()) {
          if (session.transcript) {
            disposables.push(
              palette.addItem({
                command: TRANSCRIPT_COMMAND,
                category,
                args: { id: session.id, label: session.title ?? session.name }
              })
            );
          }
        }
      };
      model.changed.connect(syncPalette);
    }

    return agents;
  }
};

export default plugin;
