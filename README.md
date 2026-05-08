# xtralab

An opinionated JupyterLab meta-package.

Bundles a curated set of extensions, a path-first file browser, a VS Code-style
git changes panel, an agent-focused launcher, and a quieter default workspace.

## Install

```bash
pip install xtralab
```

## Usage

Run JupyterLab as usual:

```bash
jupyter lab
```

Or launch as a desktop app — opens in a dedicated Chrome window with an
isolated profile, on a local server that shuts down when the window closes:

```bash
uvx --prerelease=allow xtralab
```

The `--prerelease=allow` flag is needed while `xtralab` depends on a
pre-release of JupyterLab 4.6; it can be dropped once 4.6 ships stable.

Or, after `pip install xtralab` into an environment:

```bash
xtralab
```

Requires Chrome or Chromium. macOS only for now.

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

## Run as an Electron desktop app

The Electron app lives in `desktop/`. It opens a lightweight
launcher window, lets you pick a local folder, starts a JupyterLab server for
that folder from an app-managed Python environment, waits for the ready URL,
and loads it into a hardened Electron `BrowserWindow`. Each opened folder gets
its own Jupyter server and window.

The launcher also detects common project Python environments such as `.venv`,
`venv`, `env`, `.conda`, and pixi environments. Selecting one creates a
folder-local `python3` kernelspec under xtralab's app data so notebooks execute
with the project interpreter while the JupyterLab server continues to run from
the isolated xtralab environment. If the selected interpreter is missing
`ipykernel`, xtralab leaves it alone and does not expose it as a kernel.

```bash
cd desktop
npm install
npm run dev
```

The Python package exposes `xtralab serve` as the small server helper used by
Electron. It is useful for debugging the bundled server path directly, but it
does not launch a browser by itself.

To produce an unsigned, distributable installer (DMG on macOS, AppImage on
Linux) using [Electron Forge](https://www.electronforge.io/):

```bash
cd desktop
npm run make
```

The output is written under `desktop/out/make/`. To produce an unpacked
`.app` folder without an installer wrapper, use `npm run package` instead.

`npm run dev`, `npm run package`, and `npm run make` all build a locked,
offline Python bundle before launching or packaging Electron:

- `npm run build:lock` exports the resolved Python dependencies from
  `desktop/uv.lock` to `desktop/python/wheels/requirements.txt` with hashes.
- `npm run build:wheelhouse` downloads the matching wheels into
  `desktop/python/wheels/`.
- `npm run build:python` builds the local `xtralab` wheel into that wheelhouse.
- `npm run build:runtime` prepares `desktop/python/runtime/` and installs the
  wheelhouse into it with `--no-index`.

Electron Forge copies `desktop/python/runtime/` into the packaged app's
resources directory. At runtime the desktop app starts `xtralab serve` from
that bundled runtime directly; it does not create a Python environment under
app data and does not require `uv`, `pip`, or network access on the user's
machine.

Because the build is unsigned, macOS Gatekeeper will block the first launch
with "Apple cannot check it for malicious software." Right-click the app and
choose **Open** (or run `xattr -d com.apple.quarantine /path/to/xtralab.app`)
to dismiss the warning once.

#### Dev vs release variants

Local builds — both `npm run dev` and `npm run make` — are tagged as
**xtralab dev** (bundle id `io.github.jtpio.xtralab.dev`, app data under
`~/Library/Application Support/xtralab dev/`) so they coexist with a CI-built
`xtralab.app` (bundle id `io.github.jtpio.xtralab`) without sharing dock
entries, app data, or kernels. The toggle is controlled by `process.env.CI`
in `desktop/forge.config.ts`; GitHub Actions sets that to `true` automatically,
so CI builds come out as the release variant.

To produce a release-tagged build locally (e.g. to test exactly what CI would
ship), set the variant explicitly:

```bash
cd desktop
XTRALAB_BUILD_VARIANT=release npm run make
```

### Continuous integration builds

Every push to `main` and every pull request also runs the desktop build on
GitHub Actions for macOS (Apple Silicon) and Linux (x64). The resulting DMG
and AppImage are uploaded as workflow artifacts and can be downloaded from
the run page on the repository's Actions tab.

The Electron app does not run from the repo `.venv` or require the repo checkout
at runtime. It clears inherited Python environment variables before starting
the server, points Jupyter state at xtralab's app data directory, and prepends
the bundled runtime's `bin/` directory to `PATH`. External agent CLIs are
discovered from the inherited non-Python `PATH`, `XTRALAB_EXTRA_PATH` when that
environment variable is present, and common user/system tool locations such as
`~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`.

## Development

```bash
uv pip install -e .
jlpm
jlpm build
```

## License

BSD-3-Clause
