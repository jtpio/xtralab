import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { LabIcon, ReactWidget } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import * as React from 'react';

import type { IAgent } from '../launcher/agents';

import { computeSections, IOmniboxItem } from './model';
import { loadWorkspaceFiles } from './files';

/** Construction options for {@link OmniboxWidget}. */
export interface IOmniboxOptions {
  commands: CommandRegistry;
  docRegistry: DocumentRegistry;
  /** Snapshot of the available agents, read once when the overlay opens. */
  agents: IAgent[];
  /** Placeholder text for the input. */
  placeholder: string;
  /** Seed text for the input. */
  initialQuery: string;
  /** Dismiss the overlay (the plugin disposes the widget). */
  onClose: () => void;
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
        <span className="xtralab-Omnibox-match" key={i}>
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
    <icon.react tag="span" className="xtralab-Omnibox-itemIcon" />
  ) : (
    <span className="xtralab-Omnibox-itemIcon" />
  );
}

function OmniboxComponent(props: IOmniboxOptions): JSX.Element {
  const { commands, docRegistry, agents, placeholder, initialQuery, onClose } =
    props;
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
    () => computeSections({ query, commands, docRegistry, agents, files }),
    [query, commands, docRegistry, agents, files]
  );
  const flat = React.useMemo(
    () => [...sections.commands, ...sections.files, ...sections.agents],
    [sections]
  );

  // Reset the highlighted row whenever the result set changes, and keep the
  // index in range when results shrink.
  React.useEffect(() => {
    setActive(current => (current < flat.length ? current : 0));
  }, [flat]);

  // Keep the highlighted row scrolled into view as it moves.
  React.useEffect(() => {
    listRef.current
      ?.querySelector('.xtralab-mod-active')
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
      <div className="xtralab-Omnibox-section" key={title}>
        <div className="xtralab-Omnibox-sectionHeader">{title}</div>
        {items.map((item, offset) => {
          const index = startIndex + offset;
          const isActive = index === active;
          return (
            <div
              key={item.key}
              className={
                'xtralab-Omnibox-item' + (isActive ? ' xtralab-mod-active' : '')
              }
              onMouseEnter={() => setActive(index)}
              onClick={() => run(item)}
            >
              {renderIcon(item.icon)}
              <span className="xtralab-Omnibox-itemLabel">
                {renderHighlight(item.label, item.matchIndices)}
              </span>
              {item.caption ? (
                <span className="xtralab-Omnibox-itemCaption">
                  {item.caption}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const filesStart = sections.commands.length;
  const agentsStart = filesStart + sections.files.length;

  return (
    <div
      className="xtralab-Omnibox-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) {
          dismiss();
        }
      }}
    >
      <div
        className="xtralab-Omnibox-panel"
        onMouseDown={event => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="xtralab-Omnibox-input"
          type="text"
          spellCheck={false}
          placeholder={placeholder}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="xtralab-Omnibox-results" ref={listRef}>
          {flat.length > 0 ? (
            <>
              {renderSection('Commands', sections.commands, 0)}
              {renderSection('Files', sections.files, filesStart)}
              {renderSection('Ask an agent', sections.agents, agentsStart)}
            </>
          ) : (
            <div className="xtralab-Omnibox-empty">
              {query.trim()
                ? 'No matches.'
                : 'Search files and commands, or type a prompt and pick an agent. Prefix with > for commands or / for files.'}
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
 * theme CSS variables resolve outside the shell, and its own `xtralab-Omnibox`
 * class for the overlay/panel styling (style/omnibox.css).
 */
export class OmniboxWidget extends ReactWidget {
  constructor(options: IOmniboxOptions) {
    super();
    this._options = options;
    this.id = 'xtralab-omnibox';
    this.addClass('xtralab-Omnibox');
    this.addClass('jp-ThemedContainer');
  }

  render(): JSX.Element {
    return <OmniboxComponent {...this._options} />;
  }

  private _options: IOmniboxOptions;
}
