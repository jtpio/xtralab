# xtralab

An opinionated JupyterLab meta-package.

`xtralab` bundles a curated set of JupyterLab extensions, ships its own
JupyterLab extension with a path-first file browser and a VS Code-style git
changes panel, and applies a quieter default workspace configuration. The
defaults are shipped under `etc/jupyter/labconfig` and the bundled
labextension is shipped under `share/jupyter/labextensions/xtralab`.

The goal is to keep the package easy to inspect: most behavior comes from the
upstream Jupyter packages, while `xtralab` defines the default environment we
want out of the box.

## Approach

The package brings together:

- The `ajlab` meta-package (agent-ready JupyterLab — collaboration plumbing, MCP support, command tooling, and its own quieter defaults)
- JupyterLab 4.6+
- Git server integration (`jupyterlab-git` — backs the bundled changes panel)
- Quick file opening (`jupyterlab-quickopen`)
- Cursor styling helpers (`jupyterlab-cursor-light`, `jupyterlab-cursor-theme`)
- Day and night themes (`jupyterlab-day`, `jupyterlab-night`)

These are installed as normal Python dependencies, so deployments can still
override versions and Jupyter configuration in the usual ways.

## Bundled labextension

`xtralab` ships its own prebuilt labextension that contributes:

- A path-first file browser in the left sidebar, built on `@pierre/trees`.
- A VS Code-style "Source Control" panel in the left sidebar, powered by the
  `jupyterlab-git` server REST API and `@pierre/diffs`. The bundled
  `@jupyterlab/git` frontend is disabled automatically so the two panels do
  not coexist.
- An agent-focused launcher that replaces the stock JupyterLab launcher.
  The launcher tab shows an optional initial-prompt textarea, a row of
  agent buttons (Claude, Codex, Gemini, Copilot, Goose, OpenCode, Kiro,
  and Mistral Vibe), and a collapsible list of changed files (each
  clickable into the diff viewer) below them. Clicking an agent opens a
  fresh terminal and runs the agent's CLI; if the prompt textarea is
  non-empty, the prompt is shell-quoted and spliced into the launch line
  for agents that accept one. Agents are filtered by a `which`-based
  availability check at activation, so only the ones actually installed
  on the machine show up.

### Customizing the launcher

The launcher reads `xtralab:launcher` settings from the JupyterLab settings
registry. Open the Settings Editor (`Settings → Settings Editor → xtralab
launcher`) and edit the `agents` array; xtralab merges your entries with
the defaults by `id`.

```jsonc
{
  "agents": [
    // Hide an agent you never want to see, even if it's installed:
    { "id": "kiro", "enabled": false },

    // Override an agent's command — e.g. point Claude at a shell alias.
    // `requireAvailable: false` keeps the card visible even though
    // `which cl` returns nothing (interactive shells expand the alias).
    { "id": "claude", "command": "cl", "requireAvailable": false },

    // Add a brand-new agent. `iconSvg` is optional; without it the card
    // falls back to a generic terminal icon. `promptArgs: []` means the
    // launcher's prompt textarea is appended as a positional argument.
    {
      "id": "aider",
      "label": "Aider",
      "command": "aider",
      "promptArgs": []
    }
  ]
}
```

Field reference (every field except `id` is optional):

| Field              | Effect                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Built-in id to override, or a new id to define a new card.                                                                                                                                                                                                                                                                                         |
| `label`            | Card title.                                                                                                                                                                                                                                                                                                                                        |
| `caption`          | Subtitle shown beneath the title.                                                                                                                                                                                                                                                                                                                  |
| `command`          | Literal text typed into the new terminal.                                                                                                                                                                                                                                                                                                          |
| `iconSvg`          | Inline SVG for the card icon (only needed for new agents).                                                                                                                                                                                                                                                                                         |
| `rank`             | Sort order on the launcher; lower comes first.                                                                                                                                                                                                                                                                                                     |
| `enabled`          | `false` hides the card from the launcher and palette.                                                                                                                                                                                                                                                                                              |
| `requireAvailable` | `false` skips the `which` check (use for shell aliases that aren't on PATH but expand at runtime).                                                                                                                                                                                                                                                 |
| `promptArgs`       | How to splice the launcher's optional prompt into the command. `[]` appends it as a positional argument (`<command> 'PROMPT'`); `["-i"]` or `["--prompt"]` puts it after a flag. Set to `null` to opt out — the agent button is dimmed when the prompt textarea is non-empty so a typed prompt is never silently dropped. Defaults vary per agent. |

## Default settings

`xtralab` ships the following JupyterLab defaults:

- The announcements plugin is disabled, so JupyterLab does not prompt to fetch
  news from the Jupyter news feed and does not check for application updates.
- The Table of Contents, Debugger, and Notebook Tools panels are disabled so
  they do not show up in the right sidebar by default.
- `dockPanelPadding` is off, so the main dock area is flush with the
  surrounding chrome.
- The terminal `fontFamily` defaults to `MesloLGS NF, ui-monospace, monospace`
  so Powerline / Nerd Font glyphs (used by Oh My Zsh themes such as
  `powerlevel10k`) render correctly when the font is installed; the
  `ui-monospace, monospace` fallback keeps things readable when it is not.

The JupyterLab frontend defaults are shipped as `labconfig/*.d/00-xtralab.json`
fragments so downstream meta-packages can add their own Lab configuration
fragments without replacing `xtralab`'s files.

## Install

```bash
pip install xtralab
```

## Run as a desktop app

`xtralab` ships a tiny launcher that opens JupyterLab in a dedicated Chrome
window (via Chrome's `--app` mode), with an isolated user-data directory so it
does not share cookies, extensions, or history with your normal browser.

Requires Chrome or Chromium installed. macOS only for now; other platforms will be added later.

The simplest way, no install needed:

```bash
uvx xtralab
```

Or, after `pip install xtralab` into an environment:

```bash
xtralab
```

The launcher starts a local Jupyter server on a random port with a fresh
token, waits for it to come up, opens the app window, and shuts the server
down when you close the window. `Ctrl-C` in the launching terminal also
shuts everything down cleanly.

## Development

```bash
# Install dependencies and the package in editable mode
uv pip install -e ".[dev]"
jlpm
jlpm build
```

## License

BSD-3-Clause
