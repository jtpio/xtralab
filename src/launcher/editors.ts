import { LabIcon, textEditorIcon } from '@jupyterlab/ui-components';

import { BUILTIN_EDITOR_ICONS } from './icons';

/**
 * A terminal text editor surfaced on the launcher's "Open" section. An editor
 * takes no initial prompt and is launched by typing its command into a fresh
 * terminal (e.g. `nvim`). The launcher shows a single editor tile (the first
 * available candidate; see {@link resolveEditor}); the full list is shared with
 * the terminals panel to badge running editors.
 */
export interface IEditor {
  /** Stable id; also the default `$PATH` command probed for availability. */
  id: string;
  /** Tile label, e.g. "Neovim". */
  label: string;
  /** Tile tooltip. */
  caption: string;
  /** The literal command typed into the new terminal, e.g. `nvim`. */
  command: string;
  /** Brand icon for the tile. */
  icon: LabIcon;
  /**
   * Preference order for the single launcher tile: the first candidate, by
   * ascending rank, that qualifies wins (Neovim before Vim by default).
   */
  rank: number;
  /**
   * When false, the launcher skips the `which`-based availability check for
   * this entry — useful for a shell alias or function that isn't on PATH but
   * still resolves when typed in a real terminal. Defaults to true.
   */
  requireAvailable: boolean;
}

/**
 * The settings-side shape: every field except `id` is optional, so a user can
 * override a single field on a built-in editor (e.g. swap `vim`'s command for
 * a wrapper) without restating the whole entry. New ids define brand-new
 * editors. Mirrors `IAgentSettings` minus `promptArgs`.
 */
export interface IEditorSettings {
  id: string;
  label?: string;
  caption?: string;
  command?: string;
  /**
   * Inline SVG for a custom editor's icon. Required for new ids whose icon
   * isn't shipped with xtralab; ignored for built-in ids unless explicitly
   * set (in which case it overrides the built-in).
   */
  iconSvg?: string;
  rank?: number;
  /**
   * When false, the editor is hidden from the launcher's Open section (and no
   * longer recognised by the terminals panel). Disable both built-ins to drop
   * the editor tile entirely. Defaults to true.
   */
  enabled?: boolean;
  /** See {@link IEditor.requireAvailable}. */
  requireAvailable?: boolean;
}

/**
 * Built-in editor candidates in preference order. The launcher shows the first
 * one whose command resolves on the server's `$PATH`, so Neovim wins over Vim
 * when both are installed. Users override, disable, or extend this list
 * through the `editors` setting; see {@link mergeEditors}.
 */
const DEFAULTS: IEditor[] = [
  {
    id: 'nvim',
    label: 'Neovim',
    caption: 'Open Neovim in a new terminal.',
    command: 'nvim',
    icon: BUILTIN_EDITOR_ICONS.nvim,
    rank: 0,
    requireAvailable: true
  },
  {
    id: 'vim',
    label: 'Vim',
    caption: 'Open Vim in a new terminal.',
    command: 'vim',
    icon: BUILTIN_EDITOR_ICONS.vim,
    rank: 1,
    requireAvailable: true
  }
];

/**
 * The built-in editors projected into the JSON settings shape
 * ({@link IEditorSettings}), dropping the runtime-only {@link LabIcon}. Mirrors
 * {@link defaultAgentSettings}: {@link registerLauncherSchemaDefaults} injects
 * this as the `editors` setting's schema default so the Settings Editor shows
 * the shipped list.
 */
export function defaultEditorSettings(): IEditorSettings[] {
  return DEFAULTS.map(editor => ({
    id: editor.id,
    label: editor.label,
    caption: editor.caption,
    command: editor.command,
    rank: editor.rank,
    requireAvailable: editor.requireAvailable
  }));
}

function resolveEditorIcon(id: string, iconSvg: string | undefined): LabIcon {
  if (iconSvg) {
    return new LabIcon({
      name: `xtralab:editor-custom-${id}`,
      svgstr: iconSvg
    });
  }
  return BUILTIN_EDITOR_ICONS[id] ?? textEditorIcon;
}

/**
 * Merge xtralab's built-in editors with the user's `editors` settings. Built-in
 * entries keep their fields unless explicitly overridden; user-only entries are
 * appended. `enabled: false` filters an entry out of the result entirely (so
 * callers don't need to re-check the flag). The result is sorted by rank, which
 * is also the launcher's tile-preference order. Mirrors `mergeAgents`.
 */
export function mergeEditors(overrides: IEditorSettings[]): IEditor[] {
  const overrideById = new Map(overrides.map(entry => [entry.id, entry]));
  const merged: IEditor[] = [];

  for (const base of DEFAULTS) {
    const override = overrideById.get(base.id);
    if (!override) {
      merged.push({ ...base });
      continue;
    }
    overrideById.delete(base.id);
    if (override.enabled === false) {
      continue;
    }
    merged.push({
      id: base.id,
      label: override.label ?? base.label,
      caption: override.caption ?? base.caption,
      command: override.command ?? base.command,
      icon: override.iconSvg
        ? resolveEditorIcon(base.id, override.iconSvg)
        : base.icon,
      rank: override.rank ?? base.rank,
      requireAvailable: override.requireAvailable ?? base.requireAvailable
    });
  }

  // What remains in `overrideById` are ids that don't match a built-in — treat
  // them as new editors the user is adding. Skip disabled ones; the settings
  // schema validates the shape, so missing fields just fall back here.
  let nextRank =
    merged.reduce((max, editor) => Math.max(max, editor.rank), -1) + 1;
  for (const entry of overrideById.values()) {
    if (entry.enabled === false) {
      continue;
    }
    const label = entry.label ?? entry.id;
    const command = entry.command ?? entry.id;
    merged.push({
      id: entry.id,
      label,
      caption: entry.caption ?? `Open ${label} in a new terminal.`,
      command,
      icon: resolveEditorIcon(entry.id, entry.iconSvg),
      rank: entry.rank ?? nextRank++,
      requireAvailable: entry.requireAvailable ?? true
    });
  }

  merged.sort((a, b) => a.rank - b.rank);
  return merged;
}

/**
 * Pick the single editor tile to show, given the merged editor list and the
 * set of commands known to be on `$PATH` (from the launcher's availability
 * probe). Returns the first candidate, by rank, that is either available or
 * opts out of the check (`requireAvailable: false`) — Neovim before Vim by
 * default — or `null` when none qualifies.
 *
 * When `available` is `null` (the endpoint couldn't be reached), a
 * `requireAvailable` editor is not shown; an entry with
 * `requireAvailable: false` is shown regardless.
 */
export function resolveEditor(
  editors: IEditor[],
  available: Set<string> | null
): IEditor | null {
  return (
    editors.find(
      editor =>
        !editor.requireAvailable ||
        (available !== null && available.has(editor.command))
    ) ?? null
  );
}
