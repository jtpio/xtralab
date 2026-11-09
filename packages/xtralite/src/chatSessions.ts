import type { IChatModel, IChatPanel, IChatTracker } from '@jupyter/chat';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { PathExt } from '@jupyterlab/coreutils';
import type { TranslationBundle } from '@jupyterlab/translation';
import { ISignal, Signal } from '@lumino/signaling';
import type { IAgentSession, IAgentSessionProvider } from 'xtralab';

const OPEN_CHAT_COMMAND = 'jupyterlab-chat:open';

/**
 * The message fields that tell who a message is from and for.
 */
interface IRoutedMessage {
  sender: { username: string };
  mentions?: { username: string }[];
  metadata?: { to_persona?: unknown };
}

/**
 * The open chats where a persona takes part: it sent a message, or a message
 * was sent or mentioned to it. The ask-agent popup of xtralab offers them as
 * running sessions of the persona.
 */
export class ChatSessions implements IAgentSessionProvider {
  constructor(options: ChatSessions.IOptions) {
    this._app = options.app;
    this._tracker = options.tracker;
    this._persona = options.persona;
    this._trans = options.trans;
    this._tracker.forEach(panel => this._watch(panel));
    this._tracker.widgetAdded.connect((_, panel) => {
      this._watch(panel);
      this._update();
    }, this);
    this._signature = this._computeSignature();
  }

  /**
   * Emitted when the list of sessions changes.
   */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * The open chats where the persona takes part.
   */
  list(): IAgentSession[] {
    return this._models().map(model => ({
      id: model.id!,
      label: PathExt.basename(model.name, PathExt.extname(model.name))
    }));
  }

  /**
   * Send the prompt to the persona in the chat, as the persona menu of the
   * chat does.
   */
  async sendPrompt(id: string, prompt: string): Promise<void> {
    const model = this._findModel(id);
    if (model === undefined) {
      throw new Error(this._trans.__('The chat is closed.'));
    }
    const metadata = { to_persona: this._persona };
    await model.sendMessage({ body: prompt, metadata });
  }

  /**
   * Show the chat, in the main area or in the chat side panel.
   */
  async open(id: string): Promise<void> {
    const panel = this._findPanel(id);
    if (panel === undefined) {
      throw new Error(this._trans.__('The chat is closed.'));
    }
    if (
      panel.area === 'main' ||
      !this._app.commands.hasCommand(OPEN_CHAT_COMMAND)
    ) {
      this._app.shell.activateById(panel.id);
      return;
    }
    await this._app.commands.execute(OPEN_CHAT_COMMAND, {
      filepath: panel.model.name,
      inSidePanel: true
    });
  }

  private _watch(panel: IChatPanel): void {
    const update = (): void => this._update();
    panel.model.messagesUpdated.connect(update);
    panel.disposed.connect(() => {
      panel.model.messagesUpdated.disconnect(update);
      this._update();
    });
  }

  /**
   * The models of the open chats where the persona takes part. A chat open
   * twice counts once.
   */
  private _models(): IChatModel[] {
    const models = new Map<string, IChatModel>();
    this._tracker.forEach(panel => {
      const model = panel.model;
      if (
        model.isDisposed ||
        !model.id ||
        models.has(model.id) ||
        !this._takesPart(model)
      ) {
        return;
      }
      models.set(model.id, model);
    });
    return [...models.values()];
  }

  private _takesPart(model: IChatModel): boolean {
    const persona = this._persona;
    return model.messages.some(message => {
      const routed = message as unknown as IRoutedMessage;
      return (
        routed.sender?.username === persona ||
        routed.metadata?.to_persona === persona ||
        (routed.mentions ?? []).some(user => user.username === persona)
      );
    });
  }

  private _findModel(id: string): IChatModel | undefined {
    return this._models().find(model => model.id === id);
  }

  private _findPanel(id: string): IChatPanel | undefined {
    return (
      this._tracker.find(
        panel => !panel.model.isDisposed && panel.model.id === id
      ) ?? undefined
    );
  }

  private _computeSignature(): string {
    return JSON.stringify(this.list());
  }

  /**
   * Emit `changed` when the sessions or their labels changed; messages
   * stream in often, so most updates change nothing.
   */
  private _update(): void {
    const signature = this._computeSignature();
    if (signature !== this._signature) {
      this._signature = signature;
      this._changed.emit();
    }
  }

  private _app: JupyterFrontEnd;
  private _tracker: IChatTracker;
  private _persona: string;
  private _trans: TranslationBundle;
  private _signature: string;
  private _changed = new Signal<this, void>(this);
}

/**
 * A namespace for `ChatSessions` statics.
 */
export namespace ChatSessions {
  /**
   * Construction options for {@link ChatSessions}.
   */
  export interface IOptions {
    /**
     * The application, to reveal the chats.
     */
    app: JupyterFrontEnd;
    /**
     * The tracker of the open chats.
     */
    tracker: IChatTracker;
    /**
     * The chat user id of the persona.
     */
    persona: string;
    /**
     * Translation bundle for the error messages.
     */
    trans: TranslationBundle;
  }
}
