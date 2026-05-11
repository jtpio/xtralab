# xtralab

An opinionated JupyterLab meta-package.

Bundles a curated set of extensions, a path-first file browser, a VS Code-style
git changes panel, an agent-focused launcher, and a quieter default workspace.

## Install

```bash
pip install xtralab
```

## Usage

### As a JupyterLab package

Run JupyterLab the usual way:

```bash
jupyter lab
```

### As a desktop app

Launch xtralab in a dedicated Chrome window with an isolated profile, on a
local server that shuts down when the window closes:

```bash
uvx --prerelease=allow xtralab
```

Or, after `pip install xtralab` into an environment:

```bash
xtralab
```

The `--prerelease=allow` flag is needed while `xtralab` depends on a
pre-release of JupyterLab 4.6; it can be dropped once 4.6 ships stable.
Requires Chrome or Chromium; this launcher currently runs on macOS only.

Alternatively, a standalone Electron build (DMG on macOS, AppImage on Linux)
is produced on every push to `main` — download the artifacts from the
repository's [Actions tab](https://github.com/jtpio/xtralab/actions).

## What's included

- [`ajlab`](https://github.com/jtpio/ajlab) — agent-ready JupyterLab base
- JupyterLab 4.6+
- `jupyterlab-git` — backs the bundled changes panel
- `jupyterlab-quickopen`
- `jupyterlab-cursor-light`, `jupyterlab-cursor-dark`
- `jupyterlab-day`, `jupyterlab-night` themes

The bundled labextension adds:

- A path-first file browser in the left sidebar.
- A "Source Control" panel powered by `jupyterlab-git` and `@pierre/diffs`.
- An agent launcher with a prompt textarea, a row of agent buttons (Claude,
  Codex, Gemini, Copilot, Goose, OpenCode, Kiro, Mistral Vibe), and a
  collapsible list of changed files. Buttons are filtered to agents installed
  on the machine; a typed prompt is shell-quoted and spliced into the launch
  command for agents that accept one.

## Customizing the launcher

Open `Settings → Settings Editor → xtralab launcher` and edit the `agents`
array. Entries are merged with the defaults by `id`.

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

Fields: `id` (required), `label`, `caption`, `command`, `promptArgs` (how to
splice the prompt — `[]` for positional, `["--flag"]` for flagged, `null` to
opt out), `iconSvg`, `rank`, `enabled`, `requireAvailable`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup, the
Electron desktop app architecture, and the build pipeline.

## License

BSD-3-Clause
