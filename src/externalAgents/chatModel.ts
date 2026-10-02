import {
  AbstractChatContext,
  AbstractChatModel,
  IChatContext,
  IChatModel,
  IMessageContent,
  INewMessage,
  IUser
} from '@jupyter/chat';
import { Notification } from '@jupyterlab/apputils';
import type { ITranslator, TranslationBundle } from '@jupyterlab/translation';
import type { LabIcon } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Poll } from '@lumino/polling';
import type { IToolCallsEntry } from 'jupyter-chat-components';

import { fetchTranscript } from './api';
import type { IExternalAgents, ITranscriptEntry } from './tokens';

const TRANSCRIPT_POLL_MS = 2000;

/**
 * Mime type of jupyter-chat-components; the data names the component and
 * the metadata carries its props.
 */
const COMPONENTS_MIME = 'application/vnd.jupyter.chat.components';

/**
 * The person at the keyboard: every `user` transcript entry and every prompt
 * sent from the chat input is attributed to this sender.
 */
const LOCAL_USER: IUser = {
  username: 'xtralab-user',
  display_name: 'You',
  initials: 'Y',
  color: 'var(--jp-brand-color1)'
};

/**
 * Context handed to the chat input (mentions, attachments); the sessions
 * have no user directory, so the user list is fixed.
 */
class ExternalChatContext extends AbstractChatContext {
  constructor(options: { model: IChatModel; users: IUser[] }) {
    super(options);
    this._users = options.users;
  }

  /**
   * The senders in this conversation.
   */
  get users(): IUser[] {
    return this._users;
  }

  private _users: IUser[];
}

/**
 * A chat model fed by one external session's transcript: entries stream in
 * from the server poll as messages, consecutive tool calls fold into one
 * grouped-tool-calls message, the agent's status drives the writing
 * indicator, and a message typed into the input goes back out as a prompt.
 */
export class ExternalSessionChatModel extends AbstractChatModel {
  constructor(options: ExternalSessionChatModel.IOptions) {
    super({
      commands: options.commands,
      translator: options.translator,
      config: {
        sendWithShiftEnter: false,
        stackMessages: true,
        unreadNotifications: false,
        enableCodeToolbar: true,
        inputPlaceholder: options.trans.__('Send a prompt to the agent…')
      }
    });
    this._sessionId = options.id;
    this._agents = options.agents;
    this._labels = options.trans;
    this._agent = Private.agentUser(options.agentLabel, options.icon);
    this.name = options.id;
    this.setReady(options.id);
    this._agents.changed.connect(this._onSessionsChanged, this);
    this._poll = new Poll({
      name: `@xtralab/external-agents:chat:${options.id}`,
      factory: () => this._fetch(),
      frequency: { interval: TRANSCRIPT_POLL_MS, backoff: false },
      standby: () => this._standby
    });
    this._syncStatus();
  }

  /**
   * The external session id.
   */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * The local person, so their messages render as the current user's.
   */
  get user(): IUser {
    return LOCAL_USER;
  }

  /**
   * Poll only while the tab is visible; the widget flips this.
   */
  set standby(value: boolean) {
    this._standby = value;
    if (!value) {
      void this._poll.refresh();
    }
  }

  /**
   * Deliver the typed prompt to the agent. The message shows at once and is
   * swapped for the transcript's own copy when the poll reports it.
   */
  async sendMessage(message: INewMessage): Promise<string | null> {
    const session = this._agents.find(this._sessionId);
    const body = Private.promptText(message);
    if (body.length === 0) {
      return null;
    }
    if (session === null || !session.send) {
      Notification.warning(
        session === null
          ? this._labels.__('This session is no longer running.')
          : this._labels.__('This agent does not accept prompts from outside.'),
        { autoClose: 4000 }
      );
      this.input.value = body;
      return null;
    }
    const id = `local-${++this._localCounter}`;
    const time = Date.now() / 1000;
    this.messagesInserted(this.messages.length, [
      { type: 'msg', id, time, sender: LOCAL_USER, body }
    ]);
    this._pending.push({ id, body });
    this._groupId = null;
    try {
      await this._agents.sendPrompt(this._sessionId, body);
    } catch (error) {
      this._dropPending(id);
      const detail = error instanceof Error ? error.message : '';
      Notification.error(
        detail
          ? this._labels.__('Failed to send the prompt: %1', detail)
          : this._labels.__('Failed to send the prompt.'),
        { autoClose: 5000 }
      );
      this.input.value = body;
      return null;
    }
    void this._poll.refresh();
    return id;
  }

  /**
   * The context for the chat input.
   */
  createChatContext(): IChatContext {
    return new ExternalChatContext({
      model: this,
      users: [LOCAL_USER, this._agent]
    });
  }

  /**
   * Dispose of the poll and signal connections.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._poll.dispose();
    this._agents.changed.disconnect(this._onSessionsChanged, this);
    super.dispose();
  }

  private _onSessionsChanged(): void {
    this._syncStatus();
  }

  /**
   * Turn the agent's status into the writing indicator: what it runs now
   * while busy, nothing while idle.
   */
  private _syncStatus(): void {
    const session = this._agents.find(this._sessionId);
    const status = session
      ? session.status === 'unknown'
        ? (this._lastStatus ?? 'unknown')
        : session.status
      : this._seen
        ? 'ended'
        : (this._lastStatus ?? 'unknown');
    if (session) {
      this._seen = true;
    }
    if (status === 'busy') {
      this.updateWriters([
        {
          user: this._agent,
          typingIndicator: this._currentTool
            ? this._labels.__('is running %1', this._currentTool)
            : this._labels.__('is working…')
        }
      ]);
    } else {
      this.updateWriters([]);
    }
  }

  private async _fetch(): Promise<void> {
    let page: Awaited<ReturnType<typeof fetchTranscript>>;
    try {
      page = await fetchTranscript(this._sessionId, this._offset);
    } catch (error) {
      if (!this._errored) {
        this._errored = true;
        console.warn('xtralab: transcript fetch failed', error);
      }
      return;
    }
    this._errored = false;
    // A shrunken offset means the file was rewritten: start over.
    if (this._offset !== undefined && page.offset < this._offset) {
      this.clearMessages();
      this._counter = 0;
      this._pending = [];
      this._groups.clear();
      this._callGroups.clear();
      this._groupId = null;
    }
    if (this._offset === undefined && page.truncated) {
      this.messagesInserted(0, [
        {
          type: 'msg',
          id: 'truncated',
          time: 0,
          sender: this._agent,
          body: `_${this._labels.__('Showing the most recent part of the conversation.')}_`
        }
      ]);
    }
    this._offset = page.offset;
    const batch: IMessageContent[] = [];
    for (const entry of page.entries) {
      switch (entry.kind) {
        case 'status':
          this._lastStatus = entry.text;
          if (entry.text !== 'busy') {
            this._currentTool = null;
          }
          break;
        case 'title':
          break;
        case 'tool':
          this._currentTool = Private.toolLabel(entry);
          this._addToolCall(entry, batch);
          break;
        case 'result':
          this._currentTool = null;
          this._addToolResult(entry, batch);
          break;
        default: {
          const message = this._textMessage(entry);
          if (message !== null) {
            // Text closes the current run of tool calls.
            this._groupId = null;
            batch.push(message);
          }
        }
      }
    }
    if (batch.length > 0) {
      this.messagesInserted(this.messages.length, batch);
    }
    this._syncStatus();
  }

  /**
   * A `user` or `assistant` entry as a chat message.
   */
  private _textMessage(entry: ITranscriptEntry): IMessageContent | null {
    if (entry.kind === 'user') {
      const pending = this._pending.find(p => p.body === entry.text);
      if (pending) {
        // The transcript now carries the prompt we echoed locally.
        this._dropPending(pending.id);
      }
      return {
        type: 'msg',
        id: this._nextId(),
        time: this._timeOf(entry),
        sender: LOCAL_USER,
        body: entry.text
      };
    }
    if (entry.kind === 'assistant') {
      return {
        type: 'msg',
        id: this._nextId(),
        time: this._timeOf(entry),
        sender: this._agent,
        body: entry.text
      };
    }
    return null;
  }

  /**
   * Append a tool call to the open group, or start a new group message.
   */
  private _addToolCall(
    entry: ITranscriptEntry,
    batch: IMessageContent[]
  ): void {
    const call = Private.toolCall(entry, `call-${this._counter + 1}`);
    let groupId = this._groupId;
    if (groupId === null || !this._groups.has(groupId)) {
      groupId = this._nextId();
      this._groups.set(groupId, []);
      this._groupId = groupId;
      batch.push({
        type: 'msg',
        id: groupId,
        time: this._timeOf(entry),
        sender: this._agent,
        body: '',
        mime_model: Private.groupMime([])
      });
    }
    this._groups.get(groupId)!.push(call);
    this._callGroups.set(call.toolCallId, groupId);
    this._refreshGroup(groupId, batch);
  }

  /**
   * Attach a result to its call; an orphan result becomes a group of its own.
   */
  private _addToolResult(
    entry: ITranscriptEntry,
    batch: IMessageContent[]
  ): void {
    const groupId = entry.callId
      ? this._callGroups.get(entry.callId)
      : undefined;
    const calls = groupId ? this._groups.get(groupId) : undefined;
    const call = calls?.find(c => c.toolCallId === entry.callId);
    if (groupId && call) {
      call.status = entry.name === 'error' ? 'failed' : 'completed';
      if (entry.text) {
        call.rawOutput = entry.text;
      }
      this._refreshGroup(groupId, batch);
      return;
    }
    if (!entry.text) {
      return;
    }
    const id = this._nextId();
    const orphan: IToolCallsEntry = {
      toolCallId: entry.callId ?? id,
      title:
        entry.name === 'error'
          ? this._labels.__('Error')
          : this._labels.__('Output'),
      status: entry.name === 'error' ? 'failed' : 'completed',
      rawOutput: entry.text
    };
    this._groups.set(id, [orphan]);
    batch.push({
      type: 'msg',
      id,
      time: this._timeOf(entry),
      sender: this._agent,
      body: '',
      mime_model: Private.groupMime([orphan])
    });
  }

  /**
   * Push the group's current calls into its message: the queued content
   * when the message is still in this batch, the live message otherwise.
   */
  private _refreshGroup(groupId: string, batch: IMessageContent[]): void {
    const calls = this._groups.get(groupId) ?? [];
    const mime_model = Private.groupMime(calls);
    const queued = batch.find(m => m.id === groupId);
    if (queued) {
      queued.mime_model = mime_model;
      return;
    }
    this.messages.find(m => m.id === groupId)?.update({ mime_model });
  }

  private _nextId(): string {
    return `${this._sessionId}:${++this._counter}`;
  }

  /**
   * Seconds since the epoch for an entry, always later than the previous
   * one so appended messages keep the transcript order.
   */
  private _timeOf(entry: ITranscriptEntry): number {
    const parsed = entry.ts ? Date.parse(entry.ts) / 1000 : NaN;
    const time = Number.isFinite(parsed)
      ? Math.max(parsed, this._lastTime + 0.001)
      : this._lastTime + 0.001;
    this._lastTime = time;
    return time;
  }

  private _dropPending(id: string): void {
    this._pending = this._pending.filter(p => p.id !== id);
    const index = this.messages.findIndex(m => m.id === id);
    if (index >= 0) {
      this.messagesDeleted(index, 1);
    }
  }

  private _sessionId: string;
  private _agents: IExternalAgents;
  private _labels: TranslationBundle;
  private _agent: IUser;
  private _poll: Poll;
  private _standby = true;
  private _offset: number | undefined;
  private _counter = 0;
  private _localCounter = 0;
  private _lastTime = 0;
  private _lastStatus: string | null = null;
  private _currentTool: string | null = null;
  private _seen = false;
  private _errored = false;
  private _pending: { id: string; body: string }[] = [];
  private _groupId: string | null = null;
  private _groups = new Map<string, IToolCallsEntry[]>();
  private _callGroups = new Map<string, string>();
}

/**
 * A namespace for `ExternalSessionChatModel` statics.
 */
export namespace ExternalSessionChatModel {
  /**
   * Construction options for {@link ExternalSessionChatModel}.
   */
  export interface IOptions {
    /**
     * The external session id to replay.
     */
    id: string;
    /**
     * The sessions model, for the live record and the actions.
     */
    agents: IExternalAgents;
    /**
     * Display name of the agent, the bot sender's name.
     */
    agentLabel: string;
    /**
     * The agent's icon, the bot sender's avatar.
     */
    icon: LabIcon;
    /**
     * Translation bundle for the model's own strings.
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
   * The bot sender for an agent. Its logo becomes the avatar unless the
   * glyph relies on `currentColor`, which an `<img>` cannot resolve.
   */
  export function agentUser(label: string, icon: LabIcon): IUser {
    const user: IUser = {
      username: `agent:${label}`,
      display_name: label,
      initials: label.slice(0, 2).toUpperCase(),
      color: 'var(--jp-layout-color3)',
      bot: true
    };
    if (!icon.svgstr.includes('currentColor')) {
      user.avatar_url = `data:image/svg+xml;utf8,${encodeURIComponent(icon.svgstr)}`;
    }
    return user;
  }

  /**
   * The prompt text for a typed message: its body plus one line per
   * attachment, so the agent learns which files were meant.
   */
  export function promptText(message: INewMessage): string {
    const lines = [(message.body ?? '').trim()];
    for (const attachment of message.attachments ?? []) {
      if (attachment.type === 'file') {
        const range = attachment.selection
          ? ` (lines ${attachment.selection.start[0] + 1}-${attachment.selection.end[0] + 1})`
          : '';
        lines.push(`File: ${attachment.value}${range}`);
      } else if (attachment.type === 'notebook') {
        const cells = (attachment.cells ?? []).map(cell => cell.id).join(', ');
        lines.push(`Notebook: ${attachment.value} (cells ${cells})`);
      }
    }
    return lines.filter(line => line.length > 0).join('\n');
  }

  /**
   * Short "Bash: pnpm build" form of a tool call for the writing indicator.
   */
  export function toolLabel(entry: ITranscriptEntry): string {
    const name = entry.name ?? 'tool';
    return entry.text ? `${name}: ${entry.text.split('\n', 1)[0]}` : name;
  }

  /**
   * The mime model of a grouped-tool-calls message; the calls are copied so
   * a later update is seen as new props.
   */
  export function groupMime(
    calls: IToolCallsEntry[]
  ): IMessageContent['mime_model'] {
    const props = { toolCalls: calls.map(call => ({ ...call })) };
    return {
      data: { [COMPONENTS_MIME]: 'grouped-tool-calls' },
      metadata: {
        [COMPONENTS_MIME]: props as unknown as ReadonlyPartialJSONObject
      }
    };
  }

  /**
   * Tool names of the supported agents mapped onto the component's kinds,
   * which pick the verb shown ("Running command", "Reading", "Editing"…).
   */
  const KINDS: Record<string, string> = {
    bash: 'execute',
    shell: 'execute',
    shell_command: 'execute',
    exec_command: 'execute',
    local_shell: 'execute',
    'container.exec': 'execute',
    execute: 'execute',
    run: 'execute',
    read: 'read',
    read_file: 'read',
    view: 'read',
    notebookread: 'read',
    edit: 'edit',
    multiedit: 'edit',
    write: 'edit',
    write_file: 'edit',
    edit_file: 'edit',
    create_file: 'edit',
    apply_patch: 'edit',
    notebookedit: 'edit',
    str_replace: 'edit',
    grep: 'search',
    glob: 'search',
    find: 'search',
    ls: 'search',
    list_dir: 'search',
    search: 'search',
    websearch: 'search',
    web_search: 'search',
    webfetch: 'fetch',
    web_fetch: 'fetch',
    fetch: 'fetch'
  };

  const LOCATION_KEYS = ['file_path', 'path', 'notebook_path', 'filename'];

  /**
   * Longest summary shown on a tool call row; the full input stays in the
   * expandable detail.
   */
  const SUMMARY_MAX_CHARS = 100;

  /**
   * The first line of `value`, clipped, for the row summary.
   */
  export function brief(value: string | undefined): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    const line = value.split('\n', 1)[0].trim();
    return line.length > SUMMARY_MAX_CHARS
      ? `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…`
      : line;
  }

  export function text(value: unknown): string | undefined {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
      return value.join(' ');
    }
    return undefined;
  }

  /**
   * Paths named by an `apply_patch` style input (`*** Update File: path`).
   */
  export function patchPaths(patch: string): string[] {
    const paths: string[] = [];
    for (const match of patch.matchAll(
      /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm
    )) {
      paths.push(match[1].trim());
    }
    return paths;
  }

  /**
   * A transcript tool entry as a grouped-tool-calls row: the kind picks the
   * verb, the input yields the summary, the locations and any edit diff.
   */
  export function toolCall(
    entry: ITranscriptEntry,
    fallbackId: string
  ): IToolCallsEntry {
    const name = entry.name ?? 'tool';
    const kind = KINDS[name.toLowerCase()];
    const input = entry.input;
    const fields =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const call: IToolCallsEntry = {
      toolCallId: entry.callId ?? fallbackId,
      status: 'in_progress',
      rawInput: input ?? entry.text
    };
    if (kind) {
      call.kind = kind;
    } else {
      call.title = name;
    }
    const locations: string[] = [];
    for (const key of LOCATION_KEYS) {
      const value = text(fields[key]);
      if (value) {
        locations.push(value);
        break;
      }
    }
    const patch = text(fields['patch']) ?? text(fields['input']);
    if (locations.length === 0 && kind === 'edit' && patch) {
      locations.push(...patchPaths(patch));
    }
    if (locations.length > 0) {
      call.locations = locations;
    }
    switch (kind) {
      case 'execute':
        call.summary = brief(
          text(fields['command']) ?? text(fields['cmd']) ?? entry.text
        );
        break;
      case 'search':
        call.summary = brief(
          text(fields['pattern']) ?? text(fields['query']) ?? entry.text
        );
        break;
      case 'fetch':
        call.summary = brief(text(fields['url']) ?? entry.text);
        break;
      case 'read':
      case 'edit':
        if (locations.length === 0) {
          call.summary = brief(entry.text);
        }
        break;
      default:
        call.summary = brief(entry.text);
    }
    const oldText = text(fields['old_string']);
    const newText = text(fields['new_string']) ?? text(fields['content']);
    if (kind === 'edit' && locations.length > 0 && newText !== undefined) {
      call.diffs = [{ path: locations[0], oldText: oldText ?? '', newText }];
    }
    return call;
  }
}
