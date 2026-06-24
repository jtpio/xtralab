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
  /**
   * Argv tokens spliced between `command` and a shell-quoted prompt when
   * the user types one into the launcher's prompt box. The semantics:
   *
   *   - `[]` → prompt is appended as a positional argument:
   *     `<command> 'PROMPT'`. (Used by claude, codex, vibe.)
   *   - `['-i']` / `['--prompt']` → the prompt is preceded by a flag:
   *     `<command> -i 'PROMPT'`. (Used by copilot, opencode.)
   *   - `undefined` → the agent does not accept an initial prompt. The
   *     launcher dims the agent's button while the prompt textarea is
   *     non-empty, so the user gets a clear signal rather than a silently
   *     dropped prompt.
   *
   * The prompt itself is always single-quoted with embedded single quotes
   * escaped, so multi-line prompts and shell metacharacters are safe.
   */
  promptArgs?: string[];
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
  /**
   * See `IAgent.requireAvailable`. Defaults to true for a built-in agent that
   * still uses its shipped command, and to false once you override the
   * `command` (a user-chosen command — often a shell alias — is trusted and
   * always shown). Set it explicitly to force the check on or off.
   */
  requireAvailable?: boolean;
  /**
   * See `IAgent.promptArgs`. Pass an empty array to mark the agent as
   * accepting a positional prompt; pass an array like `["-p"]` to use a
   * flag. Pass `null` to explicitly turn off prompt support for an agent
   * that has it on by default.
   */
  promptArgs?: string[] | null;
}

/**
 * Default agent cards shipped with xtralab. Seven of these (Claude, Codex,
 * Copilot, Goose, OpenCode, Kiro, Mistral Vibe) mirror first-class personas
 * in `jupyter-ai-contrib/jupyter-ai-acp-client` (which is also where their
 * icons come from), but use the bare CLI names a user would type in a
 * terminal rather than the ACP wrapper binaries that project spawns.
 * Antigravity (Google's agent-first IDE/CLI, `agy`) is the Google agent.
 * Anything not on the user's `$PATH` is filtered out at activation time, so
 * the wider list is harmless.
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
    // `agy` is the Antigravity launcher binary — a VS Code-derived editor
    // CLI that opens the Agent Manager / workspace, not a terminal REPL.
    // Its positional args are file/folder paths, so there is no inline
    // natural-language prompt form; like goose/kiro we omit promptArgs so a
    // typed prompt dims the button instead of being mangled into a path.
    // The command stays the bare binary (no `agy .`) so the server-side
    // `shutil.which` availability check still resolves it.
  },
  {
    id: 'copilot',
    label: 'Copilot',
    caption: 'Start the GitHub Copilot CLI in a new terminal.',
    command: 'copilot',
    icon: BUILTIN_AGENT_ICONS.copilot,
    rank: 3,
    requireAvailable: true,
    // `-i "PROMPT"` is the documented way to start interactive mode and
    // auto-execute the prompt; `-p` exits after responding (non-interactive).
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
    // `goose` does not accept an inline interactive prompt; users would
    // need to type the prompt after `goose session` starts.
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
    // The Kiro chat session only takes initial prompts via the in-session
    // `/chat new <prompt>` slash command, not a CLI argument.
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
  }
];

/**
 * The built-in agents projected into the JSON settings shape
 * ({@link IAgentSettings}), dropping the runtime-only {@link LabIcon}.
 * {@link registerLauncherSchemaDefaults} injects this as the `agents` setting's
 * schema default so the Settings Editor shows the shipped list.
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
    // Omit `promptArgs` for agents that don't take an inline prompt, so the
    // default doesn't show a prompt form they lack.
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
 * Merge xtralab's defaults with the user's settings. Default entries keep
 * their built-in fields unless explicitly overridden; user-only entries are
 * appended. `enabled: false` filters an entry out of the result entirely
 * (so callers don't need to check the flag again).
 *
 * Overriding a built-in agent's `command` also turns its `requireAvailable`
 * off, so the card survives the launcher's `which`-based availability filter
 * even when the new command is a shell alias the server can't resolve. See the
 * built-in branch below for the rationale.
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
      // The availability filter exists to prune xtralab's *built-in* command
      // from the launcher when it isn't installed. Once the user points the
      // agent at their own command — e.g. the `ccm` alias wrapping `claude
      // --effort=max …` — the server's `shutil.which` probe can't see it
      // (aliases and shell functions only exist inside an interactive shell),
      // so keeping the check on would wrongly hide the card. We therefore only
      // require availability while the command is still xtralab's default; a
      // user-chosen command is trusted and always shown. An explicit
      // `requireAvailable` still applies to the unchanged default command, so a
      // user can alias `claude` itself and set `requireAvailable: false` (or
      // force the check back on).
      requireAvailable:
        command === base.command
          ? (override.requireAvailable ?? base.requireAvailable)
          : false,
      // `null` is the explicit way to opt out of an agent's default prompt
      // support; an absent key keeps the default. `undefined` from `??` is
      // pruned below.
      promptArgs:
        override.promptArgs === null
          ? undefined
          : (override.promptArgs ?? base.promptArgs)
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
