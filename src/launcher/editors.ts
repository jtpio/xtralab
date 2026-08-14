import { LabIcon, textEditorIcon } from '@jupyterlab/ui-components';

import { BUILTIN_EDITOR_ICONS } from './icons';

/**
 * A terminal text editor on the launcher's "Open" section, launched by typing
 * its command into a fresh terminal. The launcher shows one tile
 * ({@link resolveEditor}); the full list badges running editors in the
 * terminals panel.
 */
export interface IEditor {
  /**
   * Stable id; also the default `$PATH` command probed for availability.
   */
  id: string;
  /**
   * Tile label, e.g. "Neovim".
   */
  label: string;
  /**
   * Tile tooltip.
   */
  caption: string;
  /**
   * The literal command typed into the new terminal, e.g. `nvim`.
   */
  command: string;
  /**
   * Brand icon for the tile.
   */
  icon: LabIcon;
  /**
   * Preference order: the first qualifying candidate by rank wins the tile.
   */
  rank: number;
  /**
   * When false, skip the `which`-based availability check — for aliases or
   * shell functions not on PATH. Defaults to true.
   */
  requireAvailable: boolean;
}

/**
 * The settings-side shape: every field except `id` is optional so a user can
 * override a single field on a built-in editor; new ids define new editors.
 * Mirrors `IAgentSettings` minus `promptArgs`.
 */
export interface IEditorSettings {
  /**
   * Id of the editor to override; a new id defines a new editor.
   */
  id: string;
  /**
   * See {@link IEditor.label}.
   */
  label?: string;
  /**
   * See {@link IEditor.caption}.
   */
  caption?: string;
  /**
   * See {@link IEditor.command}.
   */
  command?: string;
  /**
   * Inline SVG icon. Required for new ids; overrides the built-in when set on
   * a built-in id.
   */
  iconSvg?: string;
  /**
   * See {@link IEditor.rank}.
   */
  rank?: number;
  /**
   * When false, hides the editor. Disable both built-ins to drop the editor
   * tile entirely.
   */
  enabled?: boolean;
  /**
   * See {@link IEditor.requireAvailable}. Defaults to true, but flips to false
   * once `command` is overridden (a user-chosen alias is trusted).
   */
  requireAvailable?: boolean;
}

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
 * The built-in editors projected into the settings shape (no runtime LabIcon),
 * injected as the `editors` schema default so the Settings Editor shows them.
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
 * Merge the built-in editors with the user's `editors` settings; the result is
 * sorted by rank, the tile-preference order. Mirrors `mergeAgents`, including
 * turning `requireAvailable` off when a built-in's `command` is overridden.
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
    const command = override.command ?? base.command;
    merged.push({
      id: base.id,
      label: override.label ?? base.label,
      caption: override.caption ?? base.caption,
      command,
      icon: override.iconSvg
        ? resolveEditorIcon(base.id, override.iconSvg)
        : base.icon,
      rank: override.rank ?? base.rank,
      requireAvailable:
        command === base.command
          ? (override.requireAvailable ?? base.requireAvailable)
          : false
    });
  }

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
 * Pick the single tile: the first editor, by rank, that is available or opts
 * out of the check, else `null`. When `available` is `null` (probe failed),
 * only `requireAvailable: false` entries qualify.
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
