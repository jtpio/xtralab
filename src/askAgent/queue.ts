import type { ReadonlyPartialJSONValue } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import type { AskAgentTarget, IAskAgentContext } from './tokens';

/**
 * One queued prompt: a code selection, the user's instruction about it, and
 * where it should go. Every prompt is independent — a queue mixes targets
 * freely.
 */
export interface IQueuedPrompt {
  /**
   * Handle for edits and removal, unique within the page session.
   */
  id: string;

  context: IAskAgentContext;

  instruction: string;

  /**
   * The destination picked in the popup, editable in the panel. `null` when
   * a persisted target no longer parses — the panel then asks for a new pick.
   */
  target: AskAgentTarget | null;
}

let idCounter = 0;

function nextId(): string {
  return `queued-${Date.now().toString(36)}-${idCounter++}`;
}

/**
 * The accumulated ask-agent prompts awaiting a batch send. A plain
 * in-memory model; the plugin mirrors it into the state database so a page
 * reload does not silently drop typed comments.
 */
export class PromptQueue {
  constructor(items: IQueuedPrompt[] = []) {
    this._items = items;
  }

  /**
   * The queued prompts, oldest first.
   */
  get items(): readonly IQueuedPrompt[] {
    return this._items;
  }

  /**
   * Emitted whenever the queue contents change.
   */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * Append a prompt to the queue.
   */
  add(
    context: IAskAgentContext,
    instruction: string,
    target: AskAgentTarget
  ): void {
    this._items = [
      ...this._items,
      { id: nextId(), context, instruction, target }
    ];
    this._changed.emit();
  }

  /**
   * Replace the instruction of the queued prompt `id`, if still present.
   */
  updateInstruction(id: string, instruction: string): void {
    let touched = false;
    this._items = this._items.map(item => {
      if (item.id !== id || item.instruction === instruction) {
        return item;
      }
      touched = true;
      return { ...item, instruction };
    });
    if (touched) {
      this._changed.emit();
    }
  }

  /**
   * Repoint the queued prompt `id` at `target`, if still present.
   */
  updateTarget(id: string, target: AskAgentTarget): void {
    let touched = false;
    this._items = this._items.map(item => {
      if (item.id !== id) {
        return item;
      }
      touched = true;
      return { ...item, target };
    });
    if (touched) {
      this._changed.emit();
    }
  }

  /**
   * Remove the queued prompt `id`, if still present.
   */
  remove(id: string): void {
    this.removeMany([id]);
  }

  /**
   * Remove several queued prompts at once (one signal emission).
   */
  removeMany(ids: readonly string[]): void {
    const drop = new Set(ids);
    const remaining = this._items.filter(item => !drop.has(item.id));
    if (remaining.length !== this._items.length) {
      this._items = remaining;
      this._changed.emit();
    }
  }

  /**
   * Drop every queued prompt.
   */
  clear(): void {
    if (this._items.length > 0) {
      this._items = [];
      this._changed.emit();
    }
  }

  /**
   * Replace the whole queue (used to restore and to undo a clear).
   */
  reset(items: readonly IQueuedPrompt[]): void {
    this._items = [...items];
    this._changed.emit();
  }

  private _items: IQueuedPrompt[];
  private _changed = new Signal<this, void>(this);
}

/**
 * Validate one persisted context; schema drift degrades an entry instead
 * of poisoning the queue.
 */
function sanitizeContext(value: unknown): IAskAgentContext | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.path !== 'string' || raw.path.length === 0) {
    return null;
  }
  const context: IAskAgentContext = {
    path: raw.path,
    text: typeof raw.text === 'string' ? raw.text : ''
  };
  if (typeof raw.cwd === 'string') {
    context.cwd = raw.cwd;
  }
  const cell = raw.cell as { index?: unknown; type?: unknown } | null;
  if (
    cell !== null &&
    typeof cell === 'object' &&
    typeof cell.index === 'number' &&
    typeof cell.type === 'string'
  ) {
    context.cell = { index: cell.index, type: cell.type };
  }
  if (typeof raw.startLine === 'number') {
    context.startLine = raw.startLine;
  }
  if (typeof raw.endLine === 'number') {
    context.endLine = raw.endLine;
  }
  if (typeof raw.linesInWorkingFile === 'boolean') {
    context.linesInWorkingFile = raw.linesInWorkingFile;
  }
  if (typeof raw.location === 'string') {
    context.location = raw.location;
  }
  if (typeof raw.note === 'string') {
    context.note = raw.note;
  }
  return context;
}

/**
 * Validate one persisted target; anything that does not parse becomes
 * `null`, which the panel surfaces as "pick where to send this".
 */
function sanitizeTarget(value: unknown): AskAgentTarget | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const raw = value as { kind?: unknown; agentId?: unknown; name?: unknown };
  if (raw.kind === 'new' && typeof raw.agentId === 'string') {
    return { kind: 'new', agentId: raw.agentId };
  }
  if (raw.kind === 'session' && typeof raw.name === 'string') {
    return { kind: 'session', name: raw.name };
  }
  return null;
}

/**
 * Rebuild queued prompts from the state database; entries that no longer
 * parse are dropped silently.
 */
export function deserializeQueuedPrompts(value: unknown): IQueuedPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: IQueuedPrompt[] = [];
  for (const entry of value) {
    const record = entry as {
      context?: unknown;
      instruction?: unknown;
      target?: unknown;
    } | null;
    const context = sanitizeContext(record?.context);
    if (context !== null && typeof record?.instruction === 'string') {
      items.push({
        id: nextId(),
        context,
        instruction: record.instruction,
        target: sanitizeTarget(record?.target)
      });
    }
  }
  return items;
}

/**
 * The queue as a JSON value for the state database. Ids are session-scoped
 * and not persisted; fresh ones are assigned on load.
 */
export function serializeQueuedPrompts(
  items: readonly IQueuedPrompt[]
): ReadonlyPartialJSONValue {
  return items.map(({ context, instruction, target }) => ({
    context: { ...context },
    instruction,
    target: target === null ? null : { ...target }
  }));
}
