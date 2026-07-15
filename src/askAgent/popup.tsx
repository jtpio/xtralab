import type { TranslationBundle } from '@jupyterlab/translation';
import { ReactWidget } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { IAgent } from '../launcher/agents';

import type { IAskAgentContext } from './tokens';

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
  const { context, anchor, agents, initialAgentId, trans, onSubmit, onCancel } =
    props;
  const [instruction, setInstruction] = React.useState('');
  const [agentId, setAgentId] = React.useState<string>(() => {
    const known = agents.find(agent => agent.id === initialAgentId);
    return (known ?? agents[0])?.id ?? '';
  });
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
  const canSubmit =
    instruction.trim().length > 0 && selectedAgent !== undefined;

  const submit = React.useCallback(() => {
    const trimmed = instruction.trim();
    const agent = agents.find(entry => entry.id === agentId);
    if (trimmed.length === 0 || agent === undefined) {
      return;
    }
    window.setTimeout(() => {
      onSubmit(agent.id, trimmed);
    }, 0);
  }, [instruction, agents, agentId, onSubmit]);

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
      {agents.length === 0 ? (
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
          <div className="jp-xtralab-AskAgent-footer">
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
            <button
              type="button"
              className="jp-xtralab-AskAgent-submit"
              disabled={!canSubmit}
              title={trans.__('Enter to send, Esc to close')}
              onMouseDown={event => event.preventDefault()}
              onClick={submit}
            >
              {selectedAgent
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
  /** Construction options for {@link AskAgentPopup}. */
  export interface IOptions {
    /** The code selection the prompt is about. */
    context: IAskAgentContext;
    /** Viewport rectangle to anchor to; `null` centers near the top. */
    anchor: DOMRect | null;
    /** Snapshot of the prompt-capable agents, taken when the popup opens. */
    agents: IAgent[];
    /** Preferred agent id (the last one used), when still available. */
    initialAgentId: string | null;
    /** Translation bundle for the popup's own labels. */
    trans: TranslationBundle;
    /** Send the instruction to the chosen agent (the plugin closes the popup). */
    onSubmit: (agentId: string, instruction: string) => void;
    /** Dismiss the popup (the plugin disposes the widget). */
    onCancel: () => void;
  }
}
