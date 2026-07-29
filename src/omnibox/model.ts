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

/**
 * The source a result row came from, used to group rows under a header.
 */
type OmniboxItemKind = 'command' | 'file' | 'agent';

/**
 * A single result row, with the action it runs when chosen.
 */
export interface IOmniboxItem {
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
  commands: IOmniboxItem[];
  files: IOmniboxItem[];
  agents: IOmniboxItem[];
}

interface IComputeOptions {
  query: string;
  commands: CommandRegistry;
  /**
   * The command palette's items, whose labels are computed with each item's
   * args — the only form in which entries like "Use Theme: …" exist.
   */
  paletteItems: ReadonlyArray<CommandPalette.IItem>;
  docRegistry: DocumentRegistry;
  agents: IAgent[];
  files: string[];
  /**
   * Recently-used tracker; `null` disables the recent rows and recording.
   */
  recents: OmniboxRecents | null;
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
 * carrying the query as its prompt. An empty term yields the recently used
 * rows for the active mode instead (and the widget shows a hint when there
 * are none).
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
    // Agents only in the unprefixed view; the prompt is the full typed query.
    agents: mode === 'all' ? buildAgentItems(commands, agents, term, trans) : []
  };
}

/**
 * Run a command and record the use on success, so failed commands never enter
 * the recents list.
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

/**
 * Open a file and record the use on success.
 */
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
 * is missing, hidden, label-less, or its accessors throw (a command's
 * accessors can assume a context — e.g. an active notebook — the omnibox
 * doesn't provide).
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
 * recency in the unprefixed view, or only the mode's kind under a bare `>` or
 * `/`. Commands that no longer resolve are dropped, as are files missing from
 * the loaded workspace listing (while the listing is still loading — or
 * unavailable — file entries are shown as recorded).
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
 * Match the query against the palette's items first — their labels carry each
 * item's args (one "Use Theme: …" per theme, one row per font-size key), which
 * a raw registry scan can never produce — then against registry commands the
 * palette doesn't present. Palette-covered ids are skipped in the registry
 * pass so a command never also surfaces under its argless label.
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
      // An item's accessors can throw if the command assumes a context (e.g.
      // an active notebook) the omnibox doesn't provide; skip those.
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
