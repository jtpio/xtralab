import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { TranslationBundle } from '@jupyterlab/translation';
import { fileIcon, LabIcon } from '@jupyterlab/ui-components';
import { StringExt } from '@lumino/algorithm';
import type { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { CommandPalette } from '@lumino/widgets';

import type { IAgent } from '../launcher/agents';
import { agentCommandId } from '../launcher/tokens';

import type { OmniboxRecents, RecentKind } from './recents';

type OmniboxItemKind = 'command' | 'file' | 'agent';

/**
 * A single result row, with the action it runs when chosen.
 */
export interface IOmniboxItem {
  /**
   * The source category of the row: command, file, or agent.
   */
  kind: OmniboxItemKind;
  /**
   * Stable React key.
   */
  key: string;
  /**
   * Primary text shown on the row.
   */
  label: string;
  /**
   * Indices of matched characters in `label`, for highlighting. May be empty.
   */
  matchIndices: readonly number[];
  /**
   * Optional secondary text shown trailing the label.
   */
  caption?: string;
  /**
   * Optional leading icon.
   */
  icon?: LabIcon;
  /**
   * Run the row's action.
   */
  execute: () => void;
}

/**
 * Results grouped by source; each group is already capped and sorted.
 */
interface IOmniboxSections {
  /**
   * Recently used commands and files, shown while the term is empty.
   */
  recent: IOmniboxItem[];
  /**
   * Commands matching the term.
   */
  commands: IOmniboxItem[];
  /**
   * Workspace files matching the term.
   */
  files: IOmniboxItem[];
  /**
   * Per-agent "Ask" rows carrying the term as a prompt.
   */
  agents: IOmniboxItem[];
}

/**
 * Inputs for {@link computeSections}.
 */
interface IComputeOptions {
  /**
   * Raw query text from the input.
   */
  query: string;
  /**
   * The command registry used to look up and execute commands.
   */
  commands: CommandRegistry;
  /**
   * Palette items, whose labels are computed with each item's args — the only
   * form in which entries like "Use Theme: …" exist.
   */
  paletteItems: ReadonlyArray<CommandPalette.IItem>;
  /**
   * The document registry used to pick file icons.
   */
  docRegistry: DocumentRegistry;
  /**
   * The available agents; prompt-capable ones get "Ask" rows.
   */
  agents: IAgent[];
  /**
   * Workspace-relative file paths to match against.
   */
  files: string[];
  /**
   * Recently-used tracker; `null` disables the recent rows and recording.
   */
  recents: OmniboxRecents | null;
  /**
   * Translation bundle for row labels.
   */
  trans: TranslationBundle;
}

const COMMAND_LIMIT = 7;
const FILE_LIMIT = 10;

const COMMAND_PREFIX = '>';
// Unambiguous: workspace-relative paths never start with '/'.
const FILE_PREFIX = '/';

type Mode = 'all' | 'commands' | 'files';

/**
 * Build the grouped result set for a query. A leading `>` searches only
 * commands, `/` only files; otherwise every prompt-capable agent also gets an
 * "Ask" row carrying the query as its prompt. An empty term yields the
 * recently used rows for the active mode.
 */
export function computeSections(options: IComputeOptions): IOmniboxSections {
  const { query, commands, agents, trans } = options;
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
    return {
      recent: buildRecentItems(options, mode),
      commands: [],
      files: [],
      agents: []
    };
  }

  return {
    recent: [],
    commands: mode === 'files' ? [] : matchCommands(options, term),
    files: mode === 'commands' ? [] : matchFiles(options, term),
    agents: mode === 'all' ? buildAgentItems(commands, agents, term, trans) : []
  };
}

/**
 * Run a command and record the use on success, so failures never enter the recents.
 */
function executeCommand(
  commands: CommandRegistry,
  recents: OmniboxRecents | null,
  id: string,
  args?: ReadonlyPartialJSONObject
): void {
  void commands
    .execute(id, args)
    .then(() => {
      recents?.touch('command', id, args);
    })
    .catch(reason => {
      console.error(`xtralab omnibox: command "${id}" failed`, reason);
    });
}

function openFile(
  commands: CommandRegistry,
  recents: OmniboxRecents | null,
  path: string
): void {
  void commands
    .execute('docmanager:open', { path })
    .then(() => {
      recents?.touch('file', path);
    })
    .catch(reason => {
      console.error(`xtralab omnibox: failed to open "${path}"`, reason);
    });
}

/**
 * Read a command's label, visibility and caption, or `null` when the command
 * is missing, hidden, label-less, or its accessors throw (they can assume a
 * context the omnibox doesn't provide).
 */
function commandDisplay(
  commands: CommandRegistry,
  id: string,
  args?: ReadonlyPartialJSONObject
): { label: string; caption: string } | null {
  if (!commands.hasCommand(id)) {
    return null;
  }
  try {
    const label = commands.label(id, args);
    if (!label || !commands.isVisible(id, args)) {
      return null;
    }
    return { label, caption: commands.caption(id, args) };
  } catch {
    return null;
  }
}

/**
 * The recently used rows for the empty term: both kinds interleaved by
 * recency, or only the mode's kind under a bare `>` or `/`. Unresolvable
 * commands are dropped, as are files absent from the workspace listing once
 * it loads.
 */
function buildRecentItems(
  options: IComputeOptions,
  mode: Mode
): IOmniboxItem[] {
  const { commands, docRegistry, files, recents } = options;
  if (!recents) {
    return [];
  }
  const kind: RecentKind | undefined =
    mode === 'commands' ? 'command' : mode === 'files' ? 'file' : undefined;
  const knownFiles = files.length > 0 ? new Set(files) : null;

  const items: IOmniboxItem[] = [];
  for (const entry of recents.entries(kind)) {
    if (entry.kind === 'command') {
      const display = commandDisplay(commands, entry.id, entry.args);
      if (!display) {
        continue;
      }
      items.push({
        kind: 'command',
        key: `recent:command:${entry.id}:${JSON.stringify(entry.args ?? null)}`,
        label: display.label,
        matchIndices: [],
        caption: display.caption || undefined,
        execute: () => {
          executeCommand(commands, recents, entry.id, entry.args);
        }
      });
    } else {
      if (knownFiles && !knownFiles.has(entry.id)) {
        continue;
      }
      items.push({
        kind: 'file',
        key: `recent:file:${entry.id}`,
        label: entry.id,
        matchIndices: [],
        icon: fileIconForPath(docRegistry, entry.id),
        execute: () => {
          openFile(commands, recents, entry.id);
        }
      });
    }
  }
  return items;
}

/**
 * Match palette items first — their labels carry per-item args (one "Use
 * Theme: …" per theme), which a registry scan can never produce — then
 * registry commands the palette doesn't present, skipping palette-covered ids
 * so a command never also surfaces under its argless label.
 */
function matchCommands(options: IComputeOptions, term: string): IOmniboxItem[] {
  const { commands, paletteItems, recents } = options;
  const query = term.toLowerCase();
  const scored: Array<{ score: number; item: IOmniboxItem }> = [];
  const inPalette = new Set<string>();
  const seenKeys = new Set<string>();
  for (const item of paletteItems) {
    inPalette.add(item.command);
    const { command: id, args } = item;
    let label = '';
    let visible = true;
    let caption = '';
    try {
      label = item.label;
      visible = item.isVisible;
      caption = item.caption;
    } catch {
      continue;
    }
    if (!label || !visible) {
      continue;
    }
    const key = `command:${id}:${JSON.stringify(args)}`;
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    const match = StringExt.matchSumOfSquares(label.toLowerCase(), query);
    if (!match) {
      continue;
    }
    scored.push({
      score: match.score,
      item: {
        kind: 'command',
        key,
        label,
        matchIndices: match.indices,
        caption: caption || undefined,
        execute: () => {
          executeCommand(commands, recents, id, args);
        }
      }
    });
  }
  for (const id of commands.listCommands()) {
    if (inPalette.has(id)) {
      continue;
    }
    let label = '';
    let visible = true;
    let caption = '';
    try {
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
          executeCommand(commands, recents, id);
        }
      }
    });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, COMMAND_LIMIT).map(entry => entry.item);
}

function matchFiles(options: IComputeOptions, term: string): IOmniboxItem[] {
  const { commands, docRegistry, files, recents } = options;
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
      openFile(commands, recents, path);
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
    // would drop it).
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
