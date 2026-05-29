![xtralab-logo](./logo.png)

An opinionated JupyterLab meta-package for use with coding agents.

It bundles a curated set of JupyterLab extensions, a path-first file browser,
git diffs rendered by xtralab, an agent launcher, and a quieter default
workspace.

![xtralab screenshot](./screenshot.png)

## Install

```bash
pip install xtralab
```

## Usage

### As a JupyterLab package

Once installed, start JupyterLab the usual way:

```bash
jupyter lab
```

### As a desktop app

A standalone Electron build is also available, packaged as a DMG on macOS and
an AppImage on Linux. Each tagged release ships installers on the
[releases page](https://github.com/jtpio/xtralab/releases/latest), and builds
from `main` are uploaded as workflow artifacts on the
[Actions tab](https://github.com/jtpio/xtralab/actions). See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the desktop app architecture and local
build instructions.

## What's included

xtralab builds on [`ajlab`](https://github.com/jtpio/ajlab), the agent-ready
JupyterLab base. On top of it, xtralab pulls in JupyterLab 4.6+ with
`jupyterlab-git`, `jupyterlab-lsp`, `jupyterlab-quickopen`,
`jupyterlab-search-replace`, `jupyterlab-vim`, and a set of light and dark
themes (`jupyterlab-cursor-light`, `jupyterlab-cursor-dark`,
`jupyterlab-day`, `jupyterlab-night`). See
[`pyproject.toml`](./pyproject.toml) for the full list and pinned versions.

The bundled xtralab labextension then adds:

- A path-first file browser in the left sidebar.
- Git diffs rendered by xtralab in the `jupyterlab-git` panel, using
  `@pierre/diffs` for text and notebooks and a 2-up / swipe / onion-skin view
  for images.
- An agent launcher with a prompt box, buttons for the agents installed on your
  machine (Claude, Codex, Antigravity, Copilot, Goose, OpenCode, Kiro, Mistral
  Vibe), a collapsible list of changed files, and an Open row for a terminal,
  notebook, console, or your terminal editor (Neovim or Vim).
- A Terminals panel listing the running terminal sessions, each badged with the
  agent or editor detected inside it. Open terminal tabs in the main area carry
  the same icon.
- Sidebar toggle buttons in the top bar for the left and right areas.

## Connecting agents to Jupyter (MCP)

xtralab runs a [Model Context Protocol][mcp-spec] server inside JupyterLab,
provided by [`jupyter-server-mcp`][mcp]. To let a coding agent drive JupyterLab
through it, register the bundled `jupyter-server-mcp-proxy` console script with
the agent:

```bash
claude mcp add jupyter -- jupyter-server-mcp-proxy
codex mcp add jupyter -- jupyter-server-mcp-proxy
copilot mcp add jupyter -- jupyter-server-mcp-proxy
```

Run this from a terminal inside xtralab, so the proxy inherits the server
environment and discovers the running server automatically. No port is needed,
and a single registration keeps working across restarts. The launcher also
surfaces these commands with copy buttons, filtered to the agents you have
installed.

See the [`jupyter-server-mcp` README][mcp] for other MCP clients.

[mcp]: https://github.com/jupyter-ai-contrib/jupyter-server-mcp
[mcp-spec]: https://modelcontextprotocol.io

## Agent skill

xtralab ships an [Agent Skills][skills] entry at [`agent-skill/`](./agent-skill)
that teaches any coding agent how to customize JupyterLab from plain-English
requests like "hide the status bar", "change the theme", or "add a language
server". The same SKILL.md file works with Claude Code, Codex CLI, Gemini CLI,
GitHub Copilot, and other tools that read the Agent Skills format.

For Claude Code, this repository doubles as a one-plugin marketplace. Inside a
Claude Code session:

```text
/plugin marketplace add jtpio/xtralab
/plugin install xtralab-skills@xtralab
```

For agents that read from `~/.agents/skills/`, such as Codex CLI or Gemini CLI,
clone and copy the skill directory:

```bash
git clone --depth=1 https://github.com/jtpio/xtralab.git /tmp/xtralab
mkdir -p ~/.agents/skills
cp -r /tmp/xtralab/agent-skill/skills/customize-jupyterlab ~/.agents/skills/
```

See [`agent-skill/README.md`](./agent-skill/README.md) for additional install
paths, the list of supported agents, and what the skill knows.

[skills]: https://agentskills.io

## Language servers

xtralab ships [`jupyterlab-lsp`][lsp] with two language servers pre-registered:

- Python, using [`ty`](https://github.com/astral-sh/ty), which is bundled and
  works out of the box.
- TypeScript and JavaScript, using `typescript-language-server`, which you
  install yourself:

  ```bash
  npm install -g typescript-language-server typescript
  ```

  Restart JupyterLab afterwards to pick it up.

To enable another server (bash, yaml, json, pyright, and more), install its
binary and drop a JSON spec into a `jupyter_server_config.d/` directory. For
`pip install xtralab`, run `jupyter --paths` to find one (typically
`~/.jupyter/jupyter_server_config.d/`). For the desktop app, use
`~/Library/Application Support/xtralab/jupyter/config/jupyter_server_config.d/`
on macOS or `~/.config/xtralab/jupyter/config/jupyter_server_config.d/` on
Linux.

```json
{
  "LanguageServerManager": {
    "language_servers": {
      "bash-language-server": {
        "version": 2,
        "argv": ["bash-language-server", "start"],
        "languages": ["bash", "sh"],
        "mime_types": ["text/x-sh", "application/x-sh"],
        "display_name": "bash-language-server"
      }
    }
  }
}
```

See the [`jupyterlab-lsp` documentation][lsp-config] for the full spec.

[lsp]: https://github.com/jupyter-lsp/jupyterlab-lsp
[lsp-config]: https://jupyterlab-lsp.readthedocs.io/en/latest/Configuring.html

## Customizing the launcher

Open `Settings → Settings Editor → xtralab launcher` to override, hide, or add
launcher entries. Both lists below merge with xtralab's defaults by `id`.

### Agents

Edit the `agents` array:

```jsonc
{
  "agents": [
    // Hide an agent
    { "id": "kiro", "enabled": false },

    // Override an agent's command (e.g. point Claude at a shell alias)
    { "id": "claude", "command": "cl", "requireAvailable": false },

    // Add a new agent; promptArgs: [] appends the prompt as a positional arg
    { "id": "aider", "label": "Aider", "command": "aider", "promptArgs": [] }
  ]
}
```

Fields: `id` (required), `label`, `caption`, `command`, `promptArgs` (how the
prompt is spliced: `[]` for positional, `["--flag"]` for flagged, `null` to opt
out), `iconSvg`, `rank`, `enabled`, `requireAvailable`.

### Editors

The **Open** section's terminal-editor tile (Neovim, falling back to Vim) is
configured the same way through an `editors` array:

```jsonc
{
  "editors": [
    // Hide Neovim so the tile falls back to Vim (or disappears if Vim
    // isn't installed either)
    { "id": "nvim", "enabled": false },

    // Add Helix, preferred over the built-ins
    {
      "id": "helix",
      "label": "Helix",
      "command": "hx",
      "rank": -1,
      "iconSvg": "<svg>…</svg>"
    }
  ]
}
```

The launcher shows a single tile: the first editor, by `rank`, whose `command`
is on `PATH`. Disable both built-ins (`nvim`, `vim`) to remove the tile
entirely. Fields: `id` (required), `label`, `caption`, `command`, `iconSvg`,
`rank`, `enabled`, `requireAvailable`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup, the Electron
desktop app architecture, and the build pipeline.

## License

BSD-3-Clause
