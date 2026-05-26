# Config paths

JupyterLab and Jupyter Server read configuration from multiple directories, in order. The first non-system writable config directory whose scope matches the request is where customizations should live. **Run `jupyter --paths` first to see the actual search order on this machine.**

## The four directories `jupyter --paths` lists

```
config:
    <env-config>      ← e.g. .venv/etc/jupyter  — project/env-scoped
    <user-config>     ← e.g. ~/.jupyter or JUPYTER_CONFIG_DIR
    <system-config>   ← /usr/local/etc/jupyter  — system-wide (admin)
    <etc-config>      ← /etc/jupyter            — system-wide (distro)
data:
    <env-data>        ← e.g. .venv/share/jupyter
    <user-data>       ← e.g. ~/Library/Jupyter (macOS) or ~/.local/share/jupyter (Linux)
    <system-data>
    <etc-data>
runtime:
    <user-runtime>
```

For UI customization, only **config** matters. **data** holds installed kernels and labextensions — don't modify _existing_ entries there, but _adding a new sub-directory_ under `<data>/labextensions/<your-name>/` is the intended install location for an ad-hoc labextension (see [adhoc-extensions.md](adhoc-extensions.md)).

## Which path to use

**Default priority** (when no other signal from the user):

1. **Active project env's `etc/jupyter/`** — `<venv>/etc/jupyter/`, `$CONDA_PREFIX/etc/jupyter/`, or whatever `sys.prefix/etc/jupyter` resolves to. Scopes the change to this project; this is what users usually want when they're already working inside a normal venv or conda env. **Trade-off:** rebuilding the env (`rm -rf .venv && uv sync`, force-reinstall, `conda env remove`) wipes it — always mention this when writing here.
2. **The user-config entry from `jupyter --paths`** — usually `~/.jupyter/`, but `JUPYTER_CONFIG_DIR` replaces this slot when it is set. Use this when no project env is active, when the user explicitly wants the change to apply to _every_ JupyterLab they run as themselves, or when the env-config path is an installed/bundled runtime rather than the user's project env. This survives normal env rebuilds.
3. **System config** (`/usr/local/etc/jupyter/`, `/etc/jupyter/`) — only with explicit user/admin intent.

| Environment                                 | Default writable config dir                                             | Fallback / alternative                                     |
| ------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| pip install, system Python (no venv active) | `~/.jupyter/`                                                           | —                                                          |
| pip install, virtualenv active              | `<venv>/etc/jupyter/` (per-env, project-scoped)                         | `~/.jupyter/` if the user wants the change for _every_ env |
| `conda env` active                          | `$CONDA_PREFIX/etc/jupyter/` (per-env)                                  | `~/.jupyter/` (per-user)                                   |
| xtralab desktop app (macOS)                 | `~/Library/Application Support/xtralab/jupyter/config/`                 | Set by the Electron shell via `JUPYTER_CONFIG_DIR`.        |
| xtralab desktop app (Linux)                 | `~/.config/xtralab/jupyter/config/`                                     | Same mechanism.                                            |
| Docker (JupyterStack, etc.)                 | depends on the image; check `jupyter --paths` from inside the container | Often a baked-in path like `/etc/jupyter/`.                |
| JupyterHub / managed deploy                 | depends on the deployment; use the writable user-config entry if shown  | Ask the operator before writing system config.             |

**Rule of thumb:** if the user invoked the skill from inside a normal venv/conda env shell, prefer the env path. If they're asking about "my JupyterLab" in general or no project env is active, use the user-config entry from `jupyter --paths` (`JUPYTER_CONFIG_DIR` when set, `~/.jupyter/` otherwise). When in doubt, default to the env path _and_ tell the user where you wrote so they can correct you.

## What lives in each config directory

A populated config directory looks like this:

```
~/.jupyter/                                  ← user-config root
├── jupyter_server_config.py                 ← imperative Python config (optional)
├── jupyter_server_config.d/                 ← drop-in server extension snippets
│   ├── jupyterlab.json
│   └── ...
├── jupyter_notebook_config.py               ← legacy classic Notebook config (rarely needed)
└── labconfig/
    ├── page_config.d/                       ← drop-in JupyterLab page-config snippets
    │   └── *.json
    ├── default_setting_overrides.d/         ← drop-in default-settings overrides
    │   └── *.json
    └── overrides.json                       ← single-file default-setting overrides (older form)
```

And the live user-settings tree:

```
~/.jupyter/lab/user-settings/                ← per-user overrides (highest priority)
└── @jupyterlab/
    └── apputils-extension/
        └── themes.jupyterlab-settings       ← e.g. selected theme
```

## File-format quick reference

### `page_config.d/*.json`

```json
{
  "disabledExtensions": {
    "@jupyterlab/statusbar-extension:plugin": true,
    "@jupyterlab/extensionmanager-extension:plugin": true
  }
}
```

Keys also allowed at top level (less common): `federated_extensions`, `themeName`, `quitButton`, `collaborative`, `notebookStartsKernel`, `disabledLabExtensions`. Setting a key to `true` disables; to `false` re-enables one previously disabled by a lower-priority file.

### `default_setting_overrides.d/*.json`

```json
{
  "@jupyterlab/apputils-extension:themes": {
    "theme": "JupyterLab Dark"
  },
  "@jupyterlab/codemirror-extension:plugin": {
    "defaultConfig": { "highlightActiveLine": true }
  }
}
```

Keys are JupyterLab plugin IDs. Values match each plugin's `schema/*.json`. These set the default value seen if the user has not written their own setting; the Settings Editor still lets the user override.

### `jupyter_server_config.d/*.json`

For enabling a server extension:

```json
{ "ServerApp": { "jpserver_extensions": { "my_ext": true } } }
```

For registering a language server (jupyterlab-lsp):

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

### `lab/user-settings/<plugin-id-prefix>/<plugin-name>.jupyterlab-settings`

Free-form JSON5 (supports `//` comments):

```json5
{
  // @jupyterlab/apputils-extension:themes
  theme: 'Cursor Dark'
}
```

Path: `<plugin-id>` is split on `:` into directory + filename. For `@jupyterlab/apputils-extension:themes`:

- directory: `@jupyterlab/apputils-extension/`
- file: `themes.jupyterlab-settings`

## Priority order (highest wins)

1. `<user-config>/lab/user-settings/...` — written via the in-app Settings Editor
2. `default_setting_overrides.d/*.json` from any visible config dir (lexical: `99-*` beats `00-*`)
3. The plugin's own schema default
4. `page_config.d/*.json` is _not_ a settings layer — it controls whether the plugin loads at all

## xtralab desktop app

The Electron shell (`desktop/src/main.ts`) sets these env vars before launching the supervised Jupyter Server:

```
JUPYTER_CONFIG_DIR  = <Electron userData>/jupyter/config
JUPYTER_DATA_DIR    = <Electron userData>/jupyter/data
JUPYTER_RUNTIME_DIR = <platform-default runtime dir>
```

`<Electron userData>` is:

- macOS: `~/Library/Application Support/xtralab/`
- Linux: `~/.config/xtralab/`
- Windows: `%APPDATA%\xtralab\`

To customize the desktop app, write under `<JUPYTER_CONFIG_DIR>/labconfig/page_config.d/`, `default_setting_overrides.d/`, etc., creating the directories if they do not exist yet. The desktop app's bundled runtime under `desktop/python/runtime/etc/jupyter/` may appear before `JUPYTER_CONFIG_DIR` in `jupyter --paths`, but it is the _installed_ layer — never write there.

## What `jupyter --paths` does _not_ show

- The labextension-specific `disabledExtensions` array can also be set inline via `--LabApp.disabled_extensions=...` flags. Don't recommend this for persistent config; use `page_config.d/`.
- Federated extensions installed via `pip install` register under `<env-data>/labextensions/`. To install a new third-party extension, `pip install` it (read-only data dir means you can't drop files manually).

## Diagnosing "my change didn't apply"

1. Re-run `jupyter --paths` to confirm you wrote to a directory that is actually in the search list.
2. Did you restart JupyterLab? Page config and setting overrides are read at server start.
3. Is the JSON valid? A single malformed file makes the whole `.d/` directory get skipped.
4. For user-settings: check `~/.jupyter/lab/user-settings/<...>` is not overriding what you set as a default.
5. For the desktop app: did you write under the right `JUPYTER_CONFIG_DIR`? Run `xtralab` from a terminal and `echo $JUPYTER_CONFIG_DIR` inside its supervised process, or check the Electron logs.
