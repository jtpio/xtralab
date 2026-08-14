import { LabIcon, terminalIcon } from '@jupyterlab/ui-components';

import { BUILTIN_AGENT_ICONS } from './icons';

/**
 * An agent card on the launcher. `command` is the literal text typed into the
 * new terminal, so interactive-shell aliases resolve.
 */
export interface IAgent {
  id: string;
  label: string;
  caption: string;
  command: string;
  icon: LabIcon;
  rank: number;
  /**
   * When false, skip the `which`-based availability check — for aliases or
   * shell functions not on PATH. Defaults to true.
   */
  requireAvailable: boolean;
  /**
   * Argv tokens spliced between `command` and the shell-quoted prompt:
   * `[]` appends the prompt positionally, `['-i']` prefixes a flag, and
   * `undefined` means no prompt support (the launcher dims the button).
   */
  promptArgs?: string[];
}

/**
 * The settings-side shape: every field except `id` is optional so a user can
 * override a single field on a default agent; new ids define new agent cards.
 */
export interface IAgentSettings {
  id: string;
  label?: string;
  caption?: string;
  command?: string;
  /**
   * Inline SVG icon. Required for new ids; overrides the built-in when set on
   * a default id.
   */
  iconSvg?: string;
  rank?: number;
  /** When false, hides the agent from the launcher and the command palette. */
  enabled?: boolean;
  /**
   * See `IAgent.requireAvailable`. Defaults to true, but flips to false once
   * `command` is overridden (a user-chosen alias is trusted).
   */
  requireAvailable?: boolean;
  /**
   * See `IAgent.promptArgs`. `null` explicitly turns off an agent's default
   * prompt support.
   */
  promptArgs?: string[] | null;
}

/**
 * Default agent cards. Most mirror `jupyter-ai-contrib/jupyter-ai-acp-client`
 * personas but use the bare CLI names a user would type, not the ACP wrappers.
 * Anything not on `$PATH` is filtered out at activation, so the wide list is
 * harmless.
 */
const DEFAULTS: IAgent[] = [
  {
    id: 'claude',
    label: 'Claude',
    caption: 'Start Claude Code in a new terminal.',
    command: 'claude',
    icon: BUILTIN_AGENT_ICONS.claude,
    rank: 0,
    requireAvailable: true,
    promptArgs: []
  },
  {
    id: 'codex',
    label: 'Codex',
    caption: 'Start the Codex CLI in a new terminal.',
    command: 'codex',
    icon: BUILTIN_AGENT_ICONS.codex,
    rank: 1,
    requireAvailable: true,
    promptArgs: []
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    caption: 'Open Google Antigravity from a new terminal.',
    command: 'agy',
    icon: BUILTIN_AGENT_ICONS.antigravity,
    rank: 2,
    requireAvailable: true
    // `agy` opens the Antigravity editor; its positional args are paths, not
    // prompts, and the bare binary keeps the server-side `which` check working.
  },
  {
    id: 'copilot',
    label: 'Copilot',
    caption: 'Start the GitHub Copilot CLI in a new terminal.',
    command: 'copilot',
    icon: BUILTIN_AGENT_ICONS.copilot,
    rank: 3,
    requireAvailable: true,
    // `-i` starts interactive mode with the prompt; `-p` exits after responding.
    promptArgs: ['-i']
  },
  {
    id: 'goose',
    label: 'Goose',
    caption: 'Start Goose in a new terminal.',
    command: 'goose',
    icon: BUILTIN_AGENT_ICONS.goose,
    rank: 4,
    requireAvailable: true
    // `goose` takes no inline prompt; it must be typed after `goose session`.
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    caption: 'Start OpenCode in a new terminal.',
    command: 'opencode',
    icon: BUILTIN_AGENT_ICONS.opencode,
    rank: 5,
    requireAvailable: true,
    promptArgs: ['--prompt']
  },
  {
    id: 'kiro',
    label: 'Kiro',
    caption: 'Start the Kiro CLI in a new terminal.',
    command: 'kiro',
    icon: BUILTIN_AGENT_ICONS.kiro,
    rank: 6,
    requireAvailable: true
    // Kiro only takes initial prompts via the in-session `/chat new` command.
  },
  {
    id: 'mistral-vibe',
    label: 'Mistral Vibe',
    caption: 'Start Mistral Vibe in a new terminal.',
    command: 'vibe',
    icon: BUILTIN_AGENT_ICONS['mistral-vibe'],
    rank: 7,
    requireAvailable: true,
    promptArgs: []
  },
  {
    id: 'pi',
    label: 'Pi',
    caption: 'Start Pi in a new terminal.',
    command: 'pi',
    icon: BUILTIN_AGENT_ICONS.pi,
    rank: 8,
    requireAvailable: true,
    promptArgs: []
  }
];

/**
 * The built-in agents projected into the settings shape (no runtime LabIcon),
 * injected as the `agents` schema default so the Settings Editor shows them.
 */
export function defaultAgentSettings(): IAgentSettings[] {
  return DEFAULTS.map(agent => {
    const entry: IAgentSettings = {
      id: agent.id,
      label: agent.label,
      caption: agent.caption,
      command: agent.command,
      rank: agent.rank,
      requireAvailable: agent.requireAvailable
    };
    if (agent.promptArgs !== undefined) {
      entry.promptArgs = agent.promptArgs;
    }
    return entry;
  });
}

function resolveIcon(id: string, iconSvg: string | undefined): LabIcon {
  if (iconSvg) {
    return new LabIcon({ name: `xtralab:agent-custom-${id}`, svgstr: iconSvg });
  }
  return BUILTIN_AGENT_ICONS[id] ?? terminalIcon;
}

/**
 * Merge xtralab's defaults with the user's settings: defaults keep their
 * fields unless overridden, user-only ids are appended, and `enabled: false`
 * removes an entry entirely. Overriding a built-in's `command` also turns
 * `requireAvailable` off so an aliased command survives the `which` filter.
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
    const command = override.command ?? base.command;
    merged.push({
      id: base.id,
      label: override.label ?? base.label,
      caption: override.caption ?? base.caption,
      command,
      icon: override.iconSvg
        ? resolveIcon(base.id, override.iconSvg)
        : base.icon,
      rank: override.rank ?? base.rank,
      // A user-chosen command is often a shell alias `shutil.which` can't see,
      // so the availability check applies only while the command is the default.
      requireAvailable:
        command === base.command
          ? (override.requireAvailable ?? base.requireAvailable)
          : false,
      // `null` explicitly opts out of the agent's default prompt support.
      promptArgs:
        override.promptArgs === null
          ? undefined
          : (override.promptArgs ?? base.promptArgs)
    });
  }

  // Remaining override ids are new agents; the settings schema validates the
  // shape, so missing fields just fall back.
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
      requireAvailable: entry.requireAvailable ?? true,
      promptArgs:
        entry.promptArgs === null || entry.promptArgs === undefined
          ? undefined
          : entry.promptArgs
    });
  }

  merged.sort((a, b) => a.rank - b.rank);
  return merged;
}
