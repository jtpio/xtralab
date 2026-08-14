import { PathExt } from '@jupyterlab/coreutils';
import type { TranslationBundle } from '@jupyterlab/translation';
import { ReactWidget } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import * as React from 'react';

import type { IAgent } from '../launcher/agents';

import { AgentChoices, ISessionTarget, TargetChips } from './targetPicker';
import type { AskAgentTarget, IAskAgentContext } from './tokens';

const ANCHOR_GAP = 6;

const VIEWPORT_MARGIN = 8;

/**
 * Short descriptor of the prompted range for the popup header and the queue
 * panel: file name, notebook cell, line range and any clarifying tag.
 */
export function contextSummary(
  context: IAskAgentContext,
  trans: TranslationBundle
): string {
  const parts = [PathExt.basename(context.path)];
  if (context.cell !== undefined) {
    parts.push(trans.__('cell %1', context.cell.index + 1));
  }
  if (context.startLine !== undefined) {
    const endLine = context.endLine ?? context.startLine;
    parts.push(
      endLine > context.startLine
        ? trans.__('L%1–%2', context.startLine, endLine)
        : trans.__('L%1', context.startLine)
    );
  }
  if (context.note !== undefined && context.note.length > 0) {
    parts.push(context.note);
  }
  return parts.join(' · ');
}

function AskAgentPopupComponent(props: AskAgentPopup.IOptions): JSX.Element {
  const {
    context,
    anchor,
    agents,
    targets,
    initialAgentId,
    initialTargetName,
    queueCount,
    trans,
    onSubmit,
    onQueue,
    onCancel
  } = props;
  const [instruction, setInstruction] = React.useState('');
  const [agentId, setAgentId] = React.useState<string>(() => {
    const known = agents.find(agent => agent.id === initialAgentId);
    return (known ?? agents[0])?.id ?? '';
  });
  const [targetName, setTargetName] = React.useState<string | null>(
    initialTargetName
  );
  const [position, setPosition] = React.useState<{
    left: number;
    top: number;
  } | null>(null);
  const popupRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Place the popup once its size is known; hidden until placed so the
  // measurement never flashes at the wrong position.
  React.useLayoutEffect(() => {
    const node = popupRef.current;
    if (node === null) {
      return;
    }
    const rect = node.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let left: number;
    let top: number;
    if (anchor) {
      left = anchor.left;
      top = anchor.bottom + ANCHOR_GAP;
      if (top + rect.height > viewportHeight - VIEWPORT_MARGIN) {
        top = anchor.top - rect.height - ANCHOR_GAP;
      }
    } else {
      left = (viewportWidth - rect.width) / 2;
      top = viewportHeight * 0.2;
    }
    left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(left, viewportWidth - rect.width - VIEWPORT_MARGIN)
    );
    top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(top, viewportHeight - rect.height - VIEWPORT_MARGIN)
    );
    setPosition({ left, top });
  }, [anchor]);

  // Unpositioned means `visibility: hidden`, and hidden elements refuse focus.
  // With no textarea (empty state) the dialog root takes focus for Escape.
  React.useEffect(() => {
    if (position !== null) {
      (textareaRef.current ?? popupRef.current)?.focus();
    }
  }, [position]);

  const dismiss = React.useCallback(
    (restoreFocus: boolean) => {
      // Defer so this React root never unmounts synchronously inside its
      // own event handler (same pattern as the omnibox).
      window.setTimeout(() => onCancel(restoreFocus), 0);
    },
    [onCancel]
  );

  // Capture phase so a click into event-swallowing widgets still dismisses;
  // the click places focus itself, so none is restored.
  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const node = popupRef.current;
      if (
        node &&
        event.target instanceof Node &&
        !node.contains(event.target)
      ) {
        dismiss(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [dismiss]);

  const selectedAgent = agents.find(agent => agent.id === agentId);
  const selectedSession = targets.find(target => target.name === targetName);
  const canSubmit =
    instruction.trim().length > 0 &&
    (selectedSession !== undefined || selectedAgent !== undefined);

  const resolveTarget = React.useCallback((): AskAgentTarget | null => {
    const session = targets.find(entry => entry.name === targetName);
    if (session !== undefined) {
      return { kind: 'session', name: session.name };
    }
    const agent = agents.find(entry => entry.id === agentId);
    if (agent !== undefined) {
      return { kind: 'new', agentId: agent.id };
    }
    return null;
  }, [agents, agentId, targets, targetName]);

  const submit = React.useCallback(() => {
    const trimmed = instruction.trim();
    const target = resolveTarget();
    if (trimmed.length === 0 || target === null) {
      return;
    }
    // Same deferred pattern as dismiss.
    window.setTimeout(() => {
      onSubmit(target, trimmed);
    }, 0);
  }, [instruction, resolveTarget, onSubmit]);

  const queueInstruction = React.useCallback(() => {
    const trimmed = instruction.trim();
    const target = resolveTarget();
    if (trimmed.length === 0 || target === null || onQueue === undefined) {
      return;
    }
    // Same deferred pattern as submit.
    window.setTimeout(() => {
      onQueue(target, trimmed);
    }, 0);
  }, [instruction, resolveTarget, onQueue]);

  const onRootKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    }
  };

  const onTextareaKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && onQueue !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      queueInstruction();
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
  };

  const summary = contextSummary(context, trans);
  const placeholder = trans.__('Describe the change…');

  return (
    <div
      ref={popupRef}
      className="jp-xtralab-AskAgent-popup"
      role="dialog"
      aria-label={trans.__('Ask an agent about %1', summary)}
      // Focusable so clicks on non-interactive content keep Escape working
      // and the empty state can take focus at all.
      tabIndex={-1}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
      onKeyDown={onRootKeyDown}
    >
      <div className="jp-xtralab-AskAgent-context" title={context.path}>
        {summary}
      </div>
      {agents.length === 0 && targets.length === 0 ? (
        <div className="jp-xtralab-AskAgent-empty">
          {trans.__(
            'No agent accepts an initial prompt. Configure agents in the launcher settings.'
          )}
        </div>
      ) : (
        <>
          <textarea
            ref={textareaRef}
            className="jp-xtralab-AskAgent-input"
            rows={3}
            spellCheck={false}
            placeholder={placeholder}
            aria-label={placeholder}
            value={instruction}
            onChange={event => setInstruction(event.target.value)}
            onKeyDown={onTextareaKeyDown}
          />
          <TargetChips
            agents={agents}
            targets={targets}
            targetName={targetName}
            trans={trans}
            onSelect={setTargetName}
          />
          <div className="jp-xtralab-AskAgent-footer">
            {selectedSession === undefined && (
              <AgentChoices
                agents={agents}
                agentId={agentId}
                trans={trans}
                onSelect={setAgentId}
              />
            )}
            <div className="jp-xtralab-AskAgent-actions">
              {onQueue !== undefined && (
                <button
                  type="button"
                  className="jp-xtralab-AskAgent-queueButton"
                  disabled={!canSubmit}
                  title={trans.__(
                    'Queue for this destination instead of sending now — review the queue and send everything later (%1)',
                    CommandRegistry.formatKeystroke('Accel Enter')
                  )}
                  onMouseDown={event => event.preventDefault()}
                  onClick={queueInstruction}
                >
                  {queueCount !== undefined && queueCount > 0
                    ? trans.__('Queue (%1)', queueCount)
                    : trans.__('Queue')}
                </button>
              )}
              <button
                type="button"
                className="jp-xtralab-AskAgent-submit"
                disabled={!canSubmit}
                title={trans.__('Enter to send, Esc to close')}
                onMouseDown={event => event.preventDefault()}
                onClick={submit}
              >
                {selectedSession
                  ? trans.__('Send to %1', selectedSession.label)
                  : selectedAgent
                    ? trans.__('Ask %1', selectedAgent.label)
                    : trans.__('Ask agent')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The floating ask-agent prompt box, attached to `document.body`;
 * `jp-ThemedContainer` makes theme variables resolve outside the shell.
 */
export class AskAgentPopup extends ReactWidget {
  constructor(options: AskAgentPopup.IOptions) {
    super();
    this._options = options;
    this.id = 'xtralab-ask-agent-popup';
    this.addClass('jp-xtralab-AskAgent');
    this.addClass('jp-ThemedContainer');
  }

  render(): JSX.Element {
    return <AskAgentPopupComponent {...this._options} />;
  }

  private _options: AskAgentPopup.IOptions;
}

/**
 * A namespace for `AskAgentPopup` statics.
 */
export namespace AskAgentPopup {
  /**
   * Construction options for {@link AskAgentPopup}.
   */
  export interface IOptions {
    /**
     * The code selection the prompt is about.
     */
    context: IAskAgentContext;
    /**
     * Viewport rectangle to anchor to; `null` centers near the top.
     */
    anchor: DOMRect | null;
    /**
     * Snapshot of the prompt-capable agents, taken when the popup opens.
     */
    agents: IAgent[];
    /**
     * Snapshot of the running agent terminals, taken when the popup opens.
     */
    targets: ISessionTarget[];
    /**
     * Preferred agent id (the last one used), when still available.
     */
    initialAgentId: string | null;
    /**
     * Session to preselect as the target, or `null` to preselect the new
     * terminal. Must be `null` or the name of an entry in {@link targets}.
     */
    initialTargetName: string | null;
    /**
     * Number of prompts already queued, shown on the queue button.
     */
    queueCount?: number;
    /**
     * Translation bundle for the popup's own labels.
     */
    trans: TranslationBundle;
    /**
     * Send the instruction to the chosen target (the plugin closes the popup).
     */
    onSubmit: (target: AskAgentTarget, instruction: string) => void;
    /**
     * Queue the instruction for the chosen target instead of sending it.
     * The queue button is hidden when omitted.
     */
    onQueue?: (target: AskAgentTarget, instruction: string) => void;
    /**
     * Dismiss the popup. `restoreFocus` is true when the dismissal placed
     * no focus of its own (Escape).
     */
    onCancel: (restoreFocus: boolean) => void;
  }
}
