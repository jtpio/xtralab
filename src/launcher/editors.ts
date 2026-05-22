import type { LabIcon } from '@jupyterlab/ui-components';

import { neovimIcon, vimIcon } from './icons';

/**
 * A terminal text editor surfaced on the launcher's "Open" section. Unlike an
 * agent, an editor takes no initial prompt and is launched by simply typing
 * its command into a fresh terminal (e.g. `nvim`). The shape is intentionally
 * a subset of `IAgent` — no rank or `promptArgs` — because the launcher only
 * ever shows a single editor tile (see {@link resolveEditor}).
 */
export interface IEditor {
  /** Stable id; also the `$PATH` command probed for availability. */
  id: string;
  /** Tile label, e.g. "Neovim". */
  label: string;
  /** Tile tooltip. */
  caption: string;
  /** The literal command typed into the new terminal, e.g. `nvim`. */
  command: string;
  /** Brand icon for the tile. */
  icon: LabIcon;
}

/**
 * Editor candidates in preference order. The launcher shows the first one
 * whose command resolves on the server's `$PATH`, so Neovim wins over Vim
 * when both are installed.
 */
export const EDITOR_CANDIDATES: IEditor[] = [
  {
    id: 'nvim',
    label: 'Neovim',
    caption: 'Open Neovim in a new terminal.',
    command: 'nvim',
    icon: neovimIcon
  },
  {
    id: 'vim',
    label: 'Vim',
    caption: 'Open Vim in a new terminal.',
    command: 'vim',
    icon: vimIcon
  }
];

/**
 * Pick the editor tile to show, given the set of commands known to be on
 * `$PATH` (from the launcher's availability probe). Returns the first
 * available candidate — Neovim before Vim — or `null` when neither is
 * installed.
 *
 * `available` is `null` when the availability endpoint couldn't be reached.
 * The editor fails *closed* in that case (returns `null`), unlike the agent
 * list which fails open: hiding one optional tile is harmless, whereas hiding
 * every agent would leave an empty launcher.
 */
export function resolveEditor(available: Set<string> | null): IEditor | null {
  if (!available) {
    return null;
  }
  return (
    EDITOR_CANDIDATES.find(editor => available.has(editor.command)) ?? null
  );
}
