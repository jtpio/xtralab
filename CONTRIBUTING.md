# Contributing

## Development

Local development requires Python (with [uv](https://docs.astral.sh/uv/)) and
Node with [pnpm](https://pnpm.io/). The repo pins pnpm via the
`packageManager` field in `package.json`; the easiest way to get a matching
pnpm is `corepack enable && corepack prepare --activate`, or install it
manually with `npm install -g pnpm`.

```bash
uv pip install -e .
pnpm install
pnpm build
```

Then start JupyterLab the usual way to pick up the dev build.

## Electron desktop app

The Electron app lives in `desktop/`. It opens a lightweight launcher window,
lets you pick a local folder, starts a JupyterLab server for that folder from
an app-managed Python environment, waits for the ready URL, and loads it into
a hardened Electron `BrowserWindow`. Each opened folder gets its own Jupyter
server and window.

The launcher also detects common project Python environments such as `.venv`,
`venv`, `env`, `.conda`, and pixi environments. Selecting one creates a
folder-local `python3` kernelspec under xtralab's app data so notebooks execute
with the project interpreter while the JupyterLab server continues to run from
the isolated xtralab environment. If the selected interpreter is missing
`ipykernel`, xtralab leaves it alone and does not expose it as a kernel.

The companion `xtralab-desktop` package (under `desktop/`, not published to
PyPI) exposes `xtralab serve` as the small server helper used by Electron. It
is useful for debugging the bundled server path directly, but it does not
launch a browser by itself. The base `xtralab` package on PyPI stays a minimal
meta package and does not include this helper.

### Running and building

```bash
cd desktop
pnpm install
pnpm dev
```

To produce an unsigned, distributable installer (DMG on macOS, AppImage on
Linux) using [Electron Forge](https://www.electronforge.io/):

```bash
cd desktop
pnpm make
```

The output is written under `desktop/out/make/`. To produce an unpacked
`.app` folder without an installer wrapper, use `pnpm package` instead.

Because the build is unsigned, macOS Gatekeeper will block the first launch
with "Apple cannot check it for malicious software." Right-click the app and
choose **Open** (or run `xattr -d com.apple.quarantine /path/to/xtralab.app`)
to dismiss the warning once.

### Bundled Python runtime

`pnpm dev`, `pnpm package`, and `pnpm make` all build a locked,
offline Python bundle before launching or packaging Electron:

- `pnpm build:lock` exports the resolved Python dependencies from
  `desktop/uv.lock` to `desktop/python/wheels/requirements.txt` with hashes.
- `pnpm build:wheelhouse` downloads the matching wheels into
  `desktop/python/wheels/`.
- `pnpm build:python` builds the local `xtralab` and `xtralab-desktop`
  wheels into that wheelhouse.
- `pnpm build:runtime` prepares `desktop/python/runtime/` and installs the
  wheelhouse into it with `--no-index`.

Electron Forge copies `desktop/python/runtime/` into the packaged app's
resources directory. At runtime the desktop app starts `xtralab serve` from
that bundled runtime directly; it does not create a Python environment under
app data and does not require `uv`, `pip`, or network access on the user's
machine.

The Electron app does not run from the repo `.venv` or require the repo
checkout at runtime. It clears inherited Python environment variables before
starting the server, points Jupyter state at xtralab's app data directory, and
prepends the bundled runtime's `bin/` directory to `PATH`. External agent CLIs
are discovered from the inherited non-Python `PATH`, `XTRALAB_EXTRA_PATH` when
that environment variable is present, and common user/system tool locations
such as `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`.

### Dev vs release variants

Local builds — both `pnpm dev` and `pnpm make` — are tagged as
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
XTRALAB_BUILD_VARIANT=release pnpm make
```

### Continuous integration builds

Every push to `main` and every pull request also runs the desktop build on
GitHub Actions for macOS (Apple Silicon) and Linux (x64). The resulting DMG
and AppImage are uploaded as workflow artifacts and can be downloaded from
the run page on the repository's Actions tab.

When the Jupyter Releaser publishes a new GitHub Release (Step 2 of the
release workflow), the same desktop-build job runs once more against the
release tag and uploads renamed installers
(`xtralab-<version>-darwin-arm64.dmg`, `xtralab-<version>-linux-x64.AppImage`)
directly to that release's assets, alongside the Python wheel/sdist that
Jupyter Releaser pushes for PyPI.
