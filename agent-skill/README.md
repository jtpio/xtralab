# xtralab agent skills

Agent skills that teach a coding agent how to work with JupyterLab and xtralab. There are two:

- **customize-jupyterlab** turns plain-English requests like "hide the status bar", "change the theme", "add a language server", or "rearrange the activity bar" into the right config-file edits.
- **guided-code-walkthrough** drives the _running_ app over xtralab's MCP command bridge: open files, jump to and highlight specific lines, and render charts, diagrams, or explainers into a panel beside the code, so the agent can _show_ the user something instead of only describing it.

Both are built on the [Agent Skills open standard](https://agentskills.io) so the same files work in Claude Code, Codex CLI, Gemini CLI, GitHub Copilot, Cursor, Goose, OpenCode, and any other skills-compatible client.

## What's in here

```
agent-skill/
├── .claude-plugin/
│   └── plugin.json                     # Claude Code plugin manifest
└── skills/
    ├── customize-jupyterlab/
    │   ├── SKILL.md                    # configure JupyterLab from plain English
    │   └── references/
    │       ├── config-paths.md         # where configs live, decision tree
    │       ├── recipes.md              # cookbook of common requests
    │       ├── known-plugin-ids.md     # commonly-toggled plugin IDs
    │       └── adhoc-extensions.md     # ship a labextension without a build
    └── guided-code-walkthrough/
        ├── SKILL.md                    # drive the live app to walk through code
        └── references/
            ├── commands.md             # curated MCP command catalog
            ├── recipes.md              # open/highlight/visualize sequences
            └── rich-display.md         # charts and plots via the kernel
```

## Install

The xtralab repo is its own one-plugin Claude Code marketplace (via `.claude-plugin/marketplace.json` at the repo root). For other agents, copy or symlink the skill directory into `~/.agents/skills/`.

### Claude Code (two commands)

```text
/plugin marketplace add jtpio/xtralab
/plugin install xtralab-skills@xtralab
```

The first command registers this repo as a marketplace; the second installs the `xtralab-skills` plugin from it. Updates land via `/plugin marketplace update xtralab`.

### Claude Code (no install, one command — for testing)

```bash
git clone https://github.com/jtpio/xtralab.git
claude --plugin-dir ./xtralab/agent-skill
```

Loads the plugin for this session only. Good for kicking the tires.

### Codex CLI, Gemini CLI, Copilot, Cursor, Goose, OpenCode, anything else

Each skill is plain SKILL.md. Drop them into the cross-agent skills directory:

```bash
git clone --depth=1 https://github.com/jtpio/xtralab.git /tmp/xtralab
mkdir -p ~/.agents/skills
cp -r /tmp/xtralab/agent-skill/skills/* ~/.agents/skills/
```

Or for live updates from a working checkout:

```bash
mkdir -p ~/.agents/skills
ln -s "$(pwd)/agent-skill/skills/customize-jupyterlab" ~/.agents/skills/customize-jupyterlab
ln -s "$(pwd)/agent-skill/skills/guided-code-walkthrough" ~/.agents/skills/guided-code-walkthrough
```

Agent-specific paths if `~/.agents/skills/` isn't on the search list:

| Agent                                    | Path it also scans                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Claude Code                              | `~/.claude/skills/<name>/`                                                                         |
| Codex CLI                                | `~/.codex/skills/<name>/`, repo `.agents/skills/<name>/`                                           |
| Gemini CLI                               | repo `.agents/skills/<name>/`                                                                      |
| GitHub Copilot (VS Code / Visual Studio) | per the [Agent Skills docs](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) |
| Cursor                                   | manual placement; see [docs](https://cursor.com/docs/context/skills)                               |

### Project-local (xtralab developers)

To pick the skill up automatically inside the xtralab repo itself:

```bash
mkdir -p .agents/skills
ln -s ../../agent-skill/skills/customize-jupyterlab .agents/skills/customize-jupyterlab
ln -s ../../agent-skill/skills/guided-code-walkthrough .agents/skills/guided-code-walkthrough
```

## What the skills know

**customize-jupyterlab.** After install, the agent will:

- Run `jupyter --paths` before touching anything, to find the right writable config directory.
- Never edit files inside a venv / installed package.
- Pick the right config surface (`page_config.d/`, `default_setting_overrides.d/`, `jupyter_server_config.d/`, or `lab/user-settings/`) for the request type.
- Write a minimal JSON snippet at `99-*.json` rather than overwriting shipped files.
- Tell the user to restart JupyterLab (or quit-and-relaunch the xtralab desktop app) to pick up changes.
- Map xtralab-specific knobs (`xtralab:launcher`, `xtralab:sidebar`) to their dedicated settings instead of blunt plugin-disable.

Try it after install: open a project and ask "change my JupyterLab theme to dark" or "hide the status bar by default".

**guided-code-walkthrough.** After install, the agent will:

- Drive the running app through the `jupyter` MCP server, using only `list_all_commands` and `execute_command` (no edits on disk except notebooks it authors).
- Reach for a curated subset of the 480+ frontend commands rather than scanning them all, so it acts precisely.
- Open files, jump to lines, and paint a persistent highlight on a range with `xtralab:highlight-lines` (clearing with `xtralab:clear-highlights`).
- Render charts, diagrams, and explainers beside the code with the `xtralab:show` command, which paints a Markdown (incl. Mermaid), Vega-Lite, HTML, or image panel with no notebook file and no kernel, and fall back to running a notebook only when output must be computed by code.
- Check that a frontend is connected before starting, and narrate each step as the UI moves.

Try it after install: open a project and ask "walk me through how this module fits together" or "open src/index.ts and highlight the plugin list".

This skill assumes the `jupyter` MCP server is registered with the agent and a JupyterLab tab is open; in xtralab both are wired by default (see the main README's "Connecting agents to Jupyter").

## Distribution

The skill is open-standard SKILL.md, so any of these channels work:

| Channel                                                       | How                                                                                                                   | Audience                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Agent Skills marketplace** ([skills.sh](https://skills.sh)) | submit each skill directory as a public skill; users install with `npx skills add`                                    | any skills-compatible agent              |
| **Claude Code community marketplace**                         | submit this directory as a plugin via [claude.ai/settings/plugins/submit](https://claude.ai/settings/plugins/submit)  | Claude Code users                        |
| **Codex plugin marketplace**                                  | add a `.codex-plugin/plugin.json` mirror, then list in `~/.agents/plugins/marketplace.json` per the Codex plugin docs | Codex CLI users                          |
| **As part of xtralab pip release**                            | exclude from the published wheel (skill is not Python code); document the manual install path in xtralab's README     | xtralab installers who also use an agent |
| **As a separate Git repo** (`xtralab-skills`)                 | move this directory out into its own repo for cleaner versioning                                                      | all of the above                         |

A reasonable order of operations:

1. Iterate on the SKILL.md content here, where it's adjacent to the code it describes.
2. Submit to the Agent Skills marketplace first (one submission covers every cross-agent client).
3. If Claude Code's namespaced plugin install (`/plugin install ...`) becomes the dominant install path for xtralab users, add a marketplace listing in `claude-plugins-community`.
4. Consider splitting into its own repo once the skill stabilizes — the plugin manifest already declares `version`, so independent releases just need a separate tag stream.

## Notes on content

- `SKILL.md` is intentionally short. Detail lives in `references/*.md` so the agent only loads what it needs.
- Recipes prefer xtralab-native settings (`xtralab:sidebar`, `xtralab:launcher`) when they exist, and fall back to upstream JupyterLab plugin IDs otherwise.
- The customize-jupyterlab recipes match xtralab's _shipped_ defaults: if you change `page_config.d/00-xtralab.json` or `default_setting_overrides.d/00-xtralab.json` in this repo, update [`recipes.md`](skills/customize-jupyterlab/references/recipes.md) and [`known-plugin-ids.md`](skills/customize-jupyterlab/references/known-plugin-ids.md) in the same change.
- The guided-code-walkthrough catalog matches the commands xtralab and JupyterLab register today, including the `xtralab:highlight-lines` / `xtralab:clear-highlights` (`src/highlight/`) and `xtralab:show` (`src/showOutput/`) commands this repo contributes. If you add, rename, or change a walkthrough command, update [`commands.md`](skills/guided-code-walkthrough/references/commands.md) in the same change.
