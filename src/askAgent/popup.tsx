import type { TranslationBundle } from '@jupyterlab/translation';
import { addIcon, LabIcon, ReactWidget } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { IAgent } from '../launcher/agents';

import type { AskAgentTarget, IAskAgentContext } from './tokens';

/** Gap between the popup and its anchor rectangle, in pixels. */
const ANCHOR_GAP = 6;

/** Minimum distance kept between the popup and the viewport edges. */
const VIEWPORT_MARGIN = 8;

/**
 * Short human-readable descriptor of the prompted range, shown in the popup
 * header: file name, notebook cell (when applicable), line range and (for
 * diffs) which side the lines are on.
 */
function contextSummary(context: IAskAgentContext): string {
  const name = context.path.split('/').pop() ?? context.path;
  const parts = [name];
  if (context.cell !== undefined) {
    parts.push(`cell ${context.cell.index + 1}`);
  }
  if (context.startLine !== undefined) {
    const endLine = context.endLine ?? context.startLine;
    parts.push(
      endLine > context.startLine
        ? `L${context.startLine}–${endLine}`
        : `L${context.startLine}`
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
    trans,
    onSubmit,
    onCancel
  } = props;
  const [instruction, setInstruction] = React.useState('');
  const [agentId, setAgentId] = React.useState<string>(() => {
    const known = agents.find(agent => agent.id === initialAgentId);
    return (known ?? agents[0])?.id ?? '';
  });
  // The running session the prompt goes to, or `null` for a new terminal.
  const [targetName, setTargetName] = React.useState<string | null>(
    initialTargetName
  );
  const [position, setPosition] = React.useState<{
    left: number;
    top: number;
  } | null>(null);
  const popupRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Place the popup once its size is known: below the anchor, flipped above
  // when there is no room, clamped into the viewport. Hidden until placed so
  // the measurement never flashes at the wrong position.
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

  // Focus the input only once the popup is placed: while it is still
  // unpositioned it sits `visibility: hidden`, and hidden elements silently
  // refuse focus.
  React.useEffect(() => {
    if (position !== null) {
      textareaRef.current?.focus();
    }
  }, [position]);

  const dismiss = React.useCallback(() => {
    // Defer so unmounting this React root never happens synchronously inside
    // the event handler that triggered it (same pattern as the omnibox).
    window.setTimeout(onCancel, 0);
  }, [onCancel]);

  // Close when the user clicks anywhere outside the popup. Capture phase so
  // a click into widgets that swallow events still dismisses it.
  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const node = popupRef.current;
      if (
        node &&
        event.target instanceof Node &&
        !node.contains(event.target)
      ) {
        dismiss();
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

  const submit = React.useCallback(() => {
    const trimmed = instruction.trim();
    if (trimmed.length === 0) {
      return;
    }
    let target: AskAgentTarget | null = null;
    const session = targets.find(entry => entry.name === targetName);
    if (session !== undefined) {
      target = { kind: 'session', name: session.name };
    } else {
      const agent = agents.find(entry => entry.id === agentId);
      if (agent !== undefined) {
        target = { kind: 'new', agentId: agent.id };
      }
    }
    if (target === null) {
      return;
    }
    const resolved = target;
    window.setTimeout(() => {
      onSubmit(resolved, trimmed);
    }, 0);
  }, [instruction, agents, agentId, targets, targetName, onSubmit]);

  const onRootKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  };

  const onTextareaKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ): void => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
  };

  const summary = contextSummary(context);
  const placeholder = trans.__('Describe the change…');

  return (
    <div
      ref={popupRef}
      className="jp-xtralab-AskAgent-popup"
      role="dialog"
      aria-label={trans.__('Ask an agent about %1', summary)}
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
          {targets.length > 0 && (
            <div
              className="jp-xtralab-AskAgent-targets"
              role="radiogroup"
              aria-label={trans.__('Send to')}
            >
              {agents.length > 0 && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={targetName === null}
                  title={trans.__('Start the agent in a new terminal')}
                  className={
                    'jp-xtralab-AskAgent-targetButton' +
                    (targetName === null ? ' jp-mod-selected' : '')
                  }
                  // Keep focus in the textarea while picking a target.
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => setTargetName(null)}
                >
                  <addIcon.react
                    tag="span"
                    className="jp-xtralab-AskAgent-targetIcon"
                  />
                  <span className="jp-xtralab-AskAgent-targetLabel">
                    {trans.__('New terminal')}
                  </span>
                </button>
              )}
              {targets.map(target => (
                <button
                  key={target.name}
                  type="button"
                  role="radio"
                  aria-checked={target.name === targetName}
                  title={
                    target.activity
                      ? `${target.label} · ${target.name} — ${target.activity}`
                      : `${target.label} · ${target.name}`
                  }
                  className={
                    'jp-xtralab-AskAgent-targetButton' +
                    (target.name === targetName ? ' jp-mod-selected' : '')
                  }
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => setTargetName(target.name)}
                >
                  <target.icon.react
                    tag="span"
                    className="jp-xtralab-AskAgent-targetIcon"
                  />
                  <span className="jp-xtralab-AskAgent-targetLabel">
                    {target.label}
                  </span>
                  <span className="jp-xtralab-AskAgent-targetName">
                    {target.name}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="jp-xtralab-AskAgent-footer">
            {selectedSession === undefined && (
              <div
                className="jp-xtralab-AskAgent-agents"
                role="radiogroup"
                aria-label={trans.__('Agent')}
              >
                {agents.map(agent => (
                  <button
                    key={agent.id}
                    type="button"
                    role="radio"
                    aria-checked={agent.id === agentId}
                    title={agent.label}
                    className={
                      'jp-xtralab-AskAgent-agentButton' +
                      (agent.id === agentId ? ' jp-mod-selected' : '')
                    }
                    // Keep focus in the textarea while picking an agent.
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => setAgentId(agent.id)}
                  >
                    <agent.icon.react
                      tag="span"
                      className="jp-xtralab-AskAgent-agentIcon"
                    />
                  </button>
                ))}
              </div>
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
        </>
      )}
    </div>
  );
}

/**
 * The floating ask-agent prompt box. Hosts {@link AskAgentPopupComponent} in
 * a React root attached to `document.body`; `jp-ThemedContainer` makes
 * JupyterLab's theme variables resolve outside the shell (the omnibox uses
 * the same arrangement).
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
   * A running agent terminal offered as a prompt target: the session data
   * from `IAgentTerminals` plus the matching agent's icon, resolved by the
   * plugin so the popup stays presentation-only.
   */
  export interface ISessionTarget {
    /** The terminal session name. */
    name: string;
    /** The session's display label (usually the agent's name). */
    label: string;
    /** The agent's latest activity line, when one is available. */
    activity: string | null;
    /** The running agent's icon. */
    icon: LabIcon;
  }

  /** Construction options for {@link AskAgentPopup}. */
  export interface IOptions {
    /** The code selection the prompt is about. */
    context: IAskAgentContext;
    /** Viewport rectangle to anchor to; `null` centers near the top. */
    anchor: DOMRect | null;
    /** Snapshot of the prompt-capable agents, taken when the popup opens. */
    agents: IAgent[];
    /** Snapshot of the running agent terminals, taken when the popup opens. */
    targets: ISessionTarget[];
    /** Preferred agent id (the last one used), when still available. */
    initialAgentId: string | null;
    /**
     * Session to preselect as the target, or `null` to preselect the new
     * terminal. Must be `null` or the name of an entry in {@link targets}.
     */
    initialTargetName: string | null;
    /** Translation bundle for the popup's own labels. */
    trans: TranslationBundle;
    /** Send the instruction to the chosen target (the plugin closes the popup). */
    onSubmit: (target: AskAgentTarget, instruction: string) => void;
    /** Dismiss the popup (the plugin disposes the widget). */
    onCancel: () => void;
  }
}
