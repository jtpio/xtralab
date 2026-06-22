import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { TranslationBundle } from '@jupyterlab/translation';
import { fileIcon, LabIcon } from '@jupyterlab/ui-components';
import { StringExt } from '@lumino/algorithm';
import type { CommandRegistry } from '@lumino/commands';

import type { IAgent } from '../launcher/agents';
import { agentCommandId } from '../launcher/tokens';

/** The source a result row came from, used to group rows under a header. */
export type OmniboxItemKind = 'command' | 'file' | 'agent';

/** A single result row, with the action it runs when chosen. */
export interface IOmniboxItem {
  kind: OmniboxItemKind;
  /** Stable React key. */
  key: string;
  /** Primary text shown on the row. */
  label: string;
  /** Indices of matched characters in `label`, for highlighting. May be empty. */
  matchIndices: readonly number[];
  /** Optional secondary text shown trailing the label. */
  caption?: string;
  /** Optional leading icon. */
  icon?: LabIcon;
  /** Run the row's action. */
  execute: () => void;
}

/** Results grouped by source; each group is already capped and sorted. */
export interface IOmniboxSections {
  commands: IOmniboxItem[];
  files: IOmniboxItem[];
  agents: IOmniboxItem[];
}

export interface IComputeOptions {
  query: string;
  commands: CommandRegistry;
  docRegistry: DocumentRegistry;
  agents: IAgent[];
  files: string[];
  trans: TranslationBundle;
}

const COMMAND_LIMIT = 7;
const FILE_LIMIT = 10;

/**
 * Prefixes that narrow the search to a single source: a leading `>` to
 * commands, a leading `/` to files (relative paths never start with `/`, so it
 * is unambiguous). Without a prefix, every source is searched.
 */
const COMMAND_PREFIX = '>';
const FILE_PREFIX = '/';

type Mode = 'all' | 'commands' | 'files';

/**
 * Build the grouped result set for a query. A leading `>` searches only
 * commands and a leading `/` only files; otherwise commands and files are
 * fuzzy-matched and every prompt-capable agent is offered an "Ask" row
 * carrying the query as its prompt. An empty term yields no rows (the widget
 * shows a hint instead).
 */
export function computeSections(options: IComputeOptions): IOmniboxSections {
  const { query, commands, docRegistry, agents, files, trans } = options;
  const trimmed = query.trim();

  let mode: Mode = 'all';
  let term = trimmed;
  if (trimmed.startsWith(COMMAND_PREFIX)) {
    mode = 'commands';
    term = trimmed.slice(COMMAND_PREFIX.length).trim();
  } else if (trimmed.startsWith(FILE_PREFIX)) {
    mode = 'files';
    term = trimmed.slice(FILE_PREFIX.length).trim();
  }

  if (!term) {
    return { commands: [], files: [], agents: [] };
  }

  return {
    commands: mode === 'files' ? [] : matchCommands(commands, term),
    files:
      mode === 'commands' ? [] : matchFiles(commands, docRegistry, files, term),
    // Agents only in the unprefixed view; the prompt is the full typed query.
    agents: mode === 'all' ? buildAgentItems(commands, agents, term, trans) : []
  };
}

function matchCommands(
  commands: CommandRegistry,
  term: string
): IOmniboxItem[] {
  const query = term.toLowerCase();
  const scored: Array<{ score: number; item: IOmniboxItem }> = [];
  for (const id of commands.listCommands()) {
    let label = '';
    let visible = true;
    let caption = '';
    try {
      // A command's accessors can throw if they assume a context (e.g. an
      // active notebook) the omnibox doesn't provide; skip those.
      label = commands.label(id);
      visible = commands.isVisible(id);
      caption = commands.caption(id);
    } catch {
      continue;
    }
    if (!label || !visible) {
      continue;
    }
    const match = StringExt.matchSumOfSquares(label.toLowerCase(), query);
    if (!match) {
      continue;
    }
    scored.push({
      score: match.score,
      item: {
        kind: 'command',
        key: `command:${id}`,
        label,
        matchIndices: match.indices,
        caption: caption || undefined,
        execute: () => {
          void commands.execute(id).catch(reason => {
            console.error(`xtralab omnibox: command "${id}" failed`, reason);
          });
        }
      }
    });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, COMMAND_LIMIT).map(entry => entry.item);
}

function matchFiles(
  commands: CommandRegistry,
  docRegistry: DocumentRegistry,
  files: string[],
  term: string
): IOmniboxItem[] {
  const query = term.toLowerCase();
  const scored: Array<{ score: number; path: string; indices: number[] }> = [];
  for (const path of files) {
    const match = StringExt.matchSumOfSquares(path.toLowerCase(), query);
    if (match) {
      scored.push({ score: match.score, path, indices: match.indices });
    }
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, FILE_LIMIT).map(({ path, indices }) => ({
    kind: 'file',
    key: `file:${path}`,
    label: path,
    matchIndices: indices,
    icon: fileIconForPath(docRegistry, path),
    execute: () => {
      void commands.execute('docmanager:open', { path }).catch(reason => {
        console.error(`xtralab omnibox: failed to open "${path}"`, reason);
      });
    }
  }));
}

function fileIconForPath(docRegistry: DocumentRegistry, path: string): LabIcon {
  for (const fileType of docRegistry.getFileTypesForPath(path)) {
    if (fileType.icon) {
      return fileType.icon;
    }
  }
  return fileIcon;
}

function buildAgentItems(
  commands: CommandRegistry,
  agents: IAgent[],
  prompt: string,
  trans: TranslationBundle
): IOmniboxItem[] {
  const items: IOmniboxItem[] = [];
  for (const agent of agents) {
    // Agents without `promptArgs` can't take an inline prompt (the launcher
    // would drop it), so they don't belong in an "Ask …" row.
    if (agent.promptArgs === undefined) {
      continue;
    }
    items.push({
      kind: 'agent',
      key: `agent:${agent.id}`,
      label: trans.__('Ask %1', agent.label),
      matchIndices: [],
      caption: trans.__('Run prompt in a new terminal'),
      icon: agent.icon,
      execute: () => {
        void commands
          .execute(agentCommandId(agent.id), { prompt })
          .catch(reason => {
            console.error(
              `xtralab omnibox: failed to start agent "${agent.id}"`,
              reason
            );
          });
      }
    });
  }
  return items;
}
