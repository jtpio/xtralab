import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { TranslationBundle } from '@jupyterlab/translation';
import { LabIcon, ReactWidget } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import * as React from 'react';

import type { IAgent } from '../launcher/agents';

import { computeSections, IOmniboxItem } from './model';
import { loadWorkspaceFiles } from './files';
import type { OmniboxRecents } from './recents';

/**
 * DOM id of the results listbox, referenced by the input's `aria-controls`.
 */
const LIST_ID = 'jp-xtralab-Omnibox-list';

/**
 * Stable DOM id for the result row at `index`, for `aria-activedescendant`.
 */
function optionId(index: number): string {
  return `jp-xtralab-Omnibox-option-${index}`;
}

/**
 * Render `text` with the fuzzy-matched characters at `indices` wrapped in a
 * highlight span, leaving the rest as plain text.
 */
function renderHighlight(
  text: string,
  indices: readonly number[]
): React.ReactNode {
  if (indices.length === 0) {
    return text;
  }
  const matched = new Set(indices);
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const isMatch = matched.has(i);
    let j = i;
    while (j < text.length && matched.has(j) === isMatch) {
      j++;
    }
    const chunk = text.slice(i, j);
    nodes.push(
      isMatch ? (
        <span className="jp-xtralab-Omnibox-match" key={i}>
          {chunk}
        </span>
      ) : (
        <React.Fragment key={i}>{chunk}</React.Fragment>
      )
    );
    i = j;
  }
  return nodes;
}

function renderIcon(icon?: LabIcon): React.ReactNode {
  return icon ? (
    <icon.react tag="span" className="jp-xtralab-Omnibox-itemIcon" />
  ) : (
    <span className="jp-xtralab-Omnibox-itemIcon" />
  );
}

function OmniboxComponent(props: OmniboxWidget.IOptions): JSX.Element {
  const {
    commands,
    docRegistry,
    agents,
    placeholder,
    initialQuery,
    recents,
    trans,
    onClose
  } = props;
  const [query, setQuery] = React.useState(initialQuery);
  const [files, setFiles] = React.useState<string[]>([]);
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void loadWorkspaceFiles().then(loaded => {
      if (!cancelled) {
        setFiles(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = React.useMemo(
    () =>
      computeSections({
        query,
        commands,
        docRegistry,
        agents,
        files,
        recents,
        trans
      }),
    [query, commands, docRegistry, agents, files, recents, trans]
  );
  const flat = React.useMemo(
    () => [
      ...sections.recent,
      ...sections.commands,
      ...sections.files,
      ...sections.agents
    ],
    [sections]
  );
  const hasResults = flat.length > 0;

  // Reset the highlighted row whenever the result set changes, and keep the
  // index in range when results shrink.
  React.useEffect(() => {
    setActive(current => (current < flat.length ? current : 0));
  }, [flat]);

  // Keep the highlighted row scrolled into view as it moves.
  React.useEffect(() => {
    listRef.current
      ?.querySelector('.jp-mod-active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, flat]);

  const dismiss = React.useCallback(() => {
    // Defer so unmounting this React root (via onClose) never happens
    // synchronously inside the event handler that triggered it.
    window.setTimeout(onClose, 0);
  }, [onClose]);

  const run = React.useCallback(
    (item: IOmniboxItem) => {
      window.setTimeout(() => {
        onClose();
        item.execute();
      }, 0);
    },
    [onClose]
  );

  const onKeyDown = (event: React.KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        setActive(current => Math.min(current + 1, flat.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        setActive(current => Math.max(current - 1, 0));
        break;
      case 'Enter': {
        event.preventDefault();
        event.stopPropagation();
        const item = flat[active];
        if (item) {
          run(item);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        break;
      default:
        break;
    }
  };

  const renderSection = (
    title: string,
    items: IOmniboxItem[],
    startIndex: number
  ): React.ReactNode => {
    if (items.length === 0) {
      return null;
    }
    return (
      <div
        className="jp-xtralab-Omnibox-section"
        role="group"
        aria-label={title}
        key={title}
      >
        <div className="jp-xtralab-Omnibox-sectionHeader" aria-hidden="true">
          {title}
        </div>
        {items.map((item, offset) => {
          const index = startIndex + offset;
          const isActive = index === active;
          return (
            <div
              key={item.key}
              id={optionId(index)}
              role="option"
              aria-selected={isActive}
              className={
                'jp-xtralab-Omnibox-item' + (isActive ? ' jp-mod-active' : '')
              }
              onMouseEnter={() => setActive(index)}
              onClick={() => run(item)}
            >
              {renderIcon(item.icon)}
              <span className="jp-xtralab-Omnibox-itemLabel">
                {renderHighlight(item.label, item.matchIndices)}
              </span>
              {item.caption ? (
                <span className="jp-xtralab-Omnibox-itemCaption">
                  {item.caption}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const commandsStart = sections.recent.length;
  const filesStart = commandsStart + sections.commands.length;
  const agentsStart = filesStart + sections.files.length;

  return (
    <div
      className="jp-xtralab-Omnibox-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) {
          dismiss();
        }
      }}
    >
      <div
        className="jp-xtralab-Omnibox-panel"
        role="dialog"
        aria-modal="true"
        aria-label={placeholder}
        onMouseDown={event => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="jp-xtralab-Omnibox-input"
          type="text"
          spellCheck={false}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={hasResults}
          aria-controls={LIST_ID}
          aria-activedescendant={hasResults ? optionId(active) : undefined}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div
          className="jp-xtralab-Omnibox-results"
          id={LIST_ID}
          role={hasResults ? 'listbox' : undefined}
          ref={listRef}
        >
          {hasResults ? (
            <>
              {renderSection(trans.__('Recently used'), sections.recent, 0)}
              {renderSection(
                trans.__('Commands'),
                sections.commands,
                commandsStart
              )}
              {renderSection(trans.__('Files'), sections.files, filesStart)}
              {renderSection(
                trans.__('Ask an agent'),
                sections.agents,
                agentsStart
              )}
            </>
          ) : (
            <div className="jp-xtralab-Omnibox-empty">
              {query.trim()
                ? trans.__('No matches.')
                : trans.__(
                    'Search files and commands, or type a prompt and pick an agent. Prefix with > for commands or / for files.'
                  )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The omnibox overlay widget. Hosts {@link OmniboxComponent} in a React root
 * attached to `document.body`. It carries `jp-ThemedContainer` so JupyterLab's
 * theme CSS variables resolve outside the shell, and its own `jp-xtralab-Omnibox`
 * class for the overlay/panel styling (style/omnibox.css).
 */
export class OmniboxWidget extends ReactWidget {
  constructor(options: OmniboxWidget.IOptions) {
    super();
    this._options = options;
    this.id = 'xtralab-omnibox';
    this.addClass('jp-xtralab-Omnibox');
    this.addClass('jp-ThemedContainer');
  }

  render(): JSX.Element {
    return <OmniboxComponent {...this._options} />;
  }

  private _options: OmniboxWidget.IOptions;
}

/**
 * A namespace for `OmniboxWidget` statics.
 */
export namespace OmniboxWidget {
  /**
   * Construction options for {@link OmniboxWidget}.
   */
  export interface IOptions {
    commands: CommandRegistry;
    docRegistry: DocumentRegistry;
    /**
     * Snapshot of the available agents, read once when the overlay opens.
     */
    agents: IAgent[];
    /**
     * Placeholder text for the input.
     */
    placeholder: string;
    /**
     * Seed text for the input.
     */
    initialQuery: string;
    /**
     * Recently-used tracker; `null` disables the recent rows and recording.
     */
    recents: OmniboxRecents | null;
    /**
     * Translation bundle for the overlay's own labels.
     */
    trans: TranslationBundle;
    /**
     * Dismiss the overlay (the plugin disposes the widget).
     */
    onClose: () => void;
  }
}
