import { LabIcon, terminalIcon } from '@jupyterlab/ui-components';

import { BUILTIN_AGENT_ICONS } from './icons';

/**
 * The shape of an agent card on the launcher. The `command` is the literal
 * text typed into the new terminal session — interactive shells expand
 * aliases, so users can point at `claude`, `cl`, or whatever runs their
 * preferred wrapper.
 */
export interface IAgent {
  id: string;
  label: string;
  caption: string;
  command: string;
  icon: LabIcon;
  rank: number;
  /**
   * When false, the launcher skips the `which`-based availability check for
   * this entry — useful for aliases or shell functions that aren't on PATH
   * but still resolve when typed in a real terminal. Defaults to true.
   */
  requireAvailable: boolean;
}

/**
 * The settings-side shape: every field except `id` is optional, so a user
 * can override a single field on a default agent (e.g. swap the command for
 * an alias) without restating the whole entry. New ids define brand-new
 * agent cards.
 */
export interface IAgentSettings {
  id: string;
  label?: string;
  caption?: string;
  command?: string;
  /**
   * Inline SVG for a custom agent's icon. Required for new ids whose icon
   * isn't shipped with xtralab; ignored for default ids unless explicitly
   * set (in which case it overrides the built-in).
   */
  iconSvg?: string;
  rank?: number;
  /**
   * When false, the agent is hidden from the launcher and the command
   * palette. Defaults to true.
   */
  enabled?: boolean;
  /** See `IAgent.requireAvailable`. */
  requireAvailable?: boolean;
}

/**
 * Default agent cards shipped with xtralab. The list mirrors the eight
 * first-class personas in `jupyter-ai-contrib/jupyter-ai-acp-client` (which
 * is also where the icons come from), but uses the bare CLI names a user
 * would type in a terminal rather than the ACP wrapper binaries that
 * project spawns. Anything not on the user's `$PATH` is filtered out at
 * activation time, so the wider list is harmless.
 */
const DEFAULTS: IAgent[] = [
  {
    id: 'claude',
    label: 'Claude',
    caption: 'Start Claude Code in a new terminal.',
    command: 'claude',
    icon: BUILTIN_AGENT_ICONS.claude,
    rank: 0,
    requireAvailable: true
  },
  {
    id: 'codex',
    label: 'Codex',
    caption: 'Start the Codex CLI in a new terminal.',
    command: 'codex',
    icon: BUILTIN_AGENT_ICONS.codex,
    rank: 1,
    requireAvailable: true
  },
  {
    id: 'gemini',
    label: 'Gemini',
    caption: 'Start the Gemini CLI in a new terminal.',
    command: 'gemini',
    icon: BUILTIN_AGENT_ICONS.gemini,
    rank: 2,
    requireAvailable: true
  },
  {
    id: 'copilot',
    label: 'Copilot',
    caption: 'Start the GitHub Copilot CLI in a new terminal.',
    command: 'copilot',
    icon: BUILTIN_AGENT_ICONS.copilot,
    rank: 3,
    requireAvailable: true
  },
  {
    id: 'goose',
    label: 'Goose',
    caption: 'Start Goose in a new terminal.',
    command: 'goose',
    icon: BUILTIN_AGENT_ICONS.goose,
    rank: 4,
    requireAvailable: true
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    caption: 'Start OpenCode in a new terminal.',
    command: 'opencode',
    icon: BUILTIN_AGENT_ICONS.opencode,
    rank: 5,
    requireAvailable: true
  },
  {
    id: 'kiro',
    label: 'Kiro',
    caption: 'Start the Kiro CLI in a new terminal.',
    command: 'kiro',
    icon: BUILTIN_AGENT_ICONS.kiro,
    rank: 6,
    requireAvailable: true
  },
  {
    id: 'mistral-vibe',
    label: 'Mistral Vibe',
    caption: 'Start Mistral Vibe in a new terminal.',
    command: 'vibe',
    icon: BUILTIN_AGENT_ICONS['mistral-vibe'],
    rank: 7,
    requireAvailable: true
  }
];

function resolveIcon(id: string, iconSvg: string | undefined): LabIcon {
  if (iconSvg) {
    return new LabIcon({ name: `xtralab:agent-custom-${id}`, svgstr: iconSvg });
  }
  return BUILTIN_AGENT_ICONS[id] ?? terminalIcon;
}

/**
 * Merge xtralab's defaults with the user's settings. Default entries keep
 * their built-in fields unless explicitly overridden; user-only entries are
 * appended. `enabled: false` filters an entry out of the result entirely
 * (so callers don't need to check the flag again).
 */
export function mergeAgents(overrides: IAgentSettings[]): IAgent[] {
  const overrideById = new Map(overrides.map(entry => [entry.id, entry]));
  const merged: IAgent[] = [];

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
        ? resolveIcon(base.id, override.iconSvg)
        : base.icon,
      rank: override.rank ?? base.rank,
      requireAvailable: override.requireAvailable ?? base.requireAvailable
    });
  }

  // What remains in `overrideById` are entries with ids that don't match a
  // default — treat them as new agents the user is adding. Skip silently
  // when a required field is missing rather than throwing; the settings
  // schema validates the shape, so this is just a defensive fallback.
  let nextRank =
    merged.reduce((max, agent) => Math.max(max, agent.rank), -1) + 1;
  for (const entry of overrideById.values()) {
    if (entry.enabled === false) {
      continue;
    }
    const label = entry.label ?? entry.id;
    const command = entry.command ?? entry.id;
    merged.push({
      id: entry.id,
      label,
      caption: entry.caption ?? `Start ${label} in a new terminal.`,
      command,
      icon: resolveIcon(entry.id, entry.iconSvg),
      rank: entry.rank ?? nextRank++,
      requireAvailable: entry.requireAvailable ?? true
    });
  }

  merged.sort((a, b) => a.rank - b.rank);
  return merged;
}
