# Recipes

A cookbook of common customization requests. Each recipe gives the **surface**, the **target file** (relative to a writable user-config dir — usually `~/.jupyter/` or the desktop-app `JUPYTER_CONFIG_DIR`), and the **JSON snippet**.

Always create `99-user.json` rather than editing a shipped `00-*.json`, unless the recipe says otherwise. After writing, ask the user to restart JupyterLab.

---

## Appearance

### Set the default theme

**Surface:** default setting overrides
**File:** `labconfig/default_setting_overrides.d/99-theme.json`

```json
{
  "@jupyterlab/apputils-extension:themes": {
    "theme": "JupyterLab Dark"
  }
}
```

Common theme names: `"JupyterLab Light"`, `"JupyterLab Dark"`, `"Cursor Light"`, `"Cursor Dark"`, `"JupyterLab Day"`, `"JupyterLab Night"` (the last four require `jupyterlab-cursor-light`, `jupyterlab-cursor-dark`, `jupyterlab-day`, `jupyterlab-night`, all shipped with xtralab).

Alternative (per-user, overrides the default): write to `lab/user-settings/@jupyterlab/apputils-extension/themes.jupyterlab-settings`. The Settings Editor UI writes there.

### Hide the status bar

**Surface:** page config
**File:** `labconfig/page_config.d/99-statusbar.json`

```json
{ "disabledExtensions": { "@jupyterlab/statusbar-extension:plugin": true } }
```

### Hide the activity bar / use no activity bar

**Surface:** default setting overrides
**File:** `labconfig/default_setting_overrides.d/99-shell.json`

```json
{ "@jupyterlab/application-extension:shell": { "activityBarPosition": "none" } }
```

`activityBarPosition` accepts `"top"` (xtralab default), `"left"`, `"right"`, `"none"`.

### Move the activity bar to the left (classic JupyterLab look)

Same file, `"activityBarPosition": "left"`.

### Use "Simple Interface" (single-document mode) by default

**Surface:** default setting overrides
**File:** `labconfig/default_setting_overrides.d/99-shell.json`

```json
{
  "@jupyterlab/application-extension:shell": { "startMode": "single-document" }
}
```

Accepted values: `"single-document"`, `"multiple-document"`. An empty string lets the URL decide.

### Hide the main menu bar

**Surface:** page config
**File:** `labconfig/page_config.d/99-menubar.json`

```json
{ "disabledExtensions": { "@jupyterlab/mainmenu-extension:plugin": true } }
```

Note: this removes the menu entirely. Most users want individual menu items hidden via `jupyter.lab.menus` overrides instead — see "Hide one menu item" below.

### Hide a specific menu item

**Surface:** default setting overrides
**File:** `labconfig/default_setting_overrides.d/99-menus.json`

```json
{
  "@jupyterlab/application-extension:shell": {},
  "@jupyterlab/mainmenu-extension:plugin": {
    "menus": [{ "id": "jp-mainmenu-help", "disabled": true }]
  }
}
```

Menu IDs come from the contributing extension's schema. Inspect with `Settings → Settings Editor → Main Menu`.

---

## Sidebars and panels

### Hide the default file browser tab

**Surface (xtralab):** user setting
**File:** `lab/user-settings/xtralab/sidebar.jupyterlab-settings`

```json5
{ showDefaultFileBrowser: false }
```

**Surface (vanilla JupyterLab):** page config
**File:** `labconfig/page_config.d/99-filebrowser.json`

```json
{ "disabledExtensions": { "@jupyterlab/filebrowser-extension:browser": true } }
```

### Hide Running Terminals and Kernels

**Surface (xtralab):** user setting
**File:** `lab/user-settings/xtralab/sidebar.jupyterlab-settings`

```json5
{ showRunningSessions: false }
```

**Surface (vanilla):** page config — disable `@jupyterlab/running-extension:plugin`.

### Show hidden files in the file browser by default

**Surface:** default setting overrides
**File:** `labconfig/default_setting_overrides.d/99-filebrowser.json`

```json
{ "@jupyterlab/filebrowser-extension:browser": { "showHiddenFiles": true } }
```

(ajlab / xtralab already enable this by default.)

### Reorder the left sidebar

**Surface:** default setting overrides
**File:** `labconfig/default_setting_overrides.d/99-shell.json`

```json
{
  "@jupyterlab/application-extension:shell": {
    "layout": {
      "single": {
        "filebrowser": { "options": { "rank": 1 } },
        "jp-running-sessions": { "options": { "rank": 2 } }
      },
      "multiple": {
        "filebrowser": { "options": { "rank": 1 } },
        "jp-running-sessions": { "options": { "rank": 2 } }
      }
    }
  }
}
```

Tab IDs come from the contributing extension. To find an ID, hover the tab in the running app or open `Settings → Settings Editor → Application Shell`.

---

## Editor and notebook behavior

### Enable line wrapping in the code editor

**Surface:** default setting overrides
**File:** `labconfig/default_setting_overrides.d/99-codemirror.json`

```json
{
  "@jupyterlab/codemirror-extension:plugin": {
    "defaultConfig": {
      "lineWrap": "on"
    }
  }
}
```

Other useful `defaultConfig` keys: `autoClosingBrackets`, `codeFolding`, `highlightActiveLine`, `highlightTrailingWhitespace`, `scrollPastEnd`, `lineNumbers`, `indentUnit`, `tabSize`.

### Show line numbers in notebook cells

**Surface:** default setting overrides
**File:** `labconfig/default_setting_overrides.d/99-notebook.json`

```json
{
  "@jupyterlab/notebook-extension:tracker": {
    "codeCellConfig": { "lineNumbers": true },
    "markdownCellConfig": { "lineNumbers": true },
    "rawCellConfig": { "lineNumbers": true }
  }
}
```

### Enable Vim mode

Step 1: install `jupyterlab-vim` (`pip install jupyterlab-vim`) if not already.
Step 2 (xtralab only — vim is disabled by default): re-enable it
**File:** `labconfig/page_config.d/99-vim.json`

```json
{ "disabledExtensions": { "@axlair/jupyterlab_vim": false } }
```

### Record notebook cell timing

**Surface:** default setting overrides

```json
{ "@jupyterlab/notebook-extension:tracker": { "recordTiming": true } }
```

### Configure the completer (continuous hints, docs panel)

```json
{
  "@jupyterlab/completer-extension:manager": {
    "autoCompletion": true,
    "showDocumentationPanel": true
  },
  "@jupyter-lsp/jupyterlab-lsp:completion": {
    "continuousHinting": true
  }
}
```

---

## Terminal

### Change the terminal font

```json
{
  "@jupyterlab/terminal-extension:plugin": {
    "fontFamily": "MesloLGS NF, ui-monospace, monospace",
    "fontSize": 13
  }
}
```

### Change the default terminal shell

**Surface:** server config (`jupyter_server_config.py`, NOT a JSON drop-in)

```python
c.ServerApp.terminado_settings = {"shell_command": ["/bin/zsh", "-l"]}
```

Drop-in JSON equivalent at `jupyter_server_config.d/99-terminal.json`:

```json
{
  "ServerApp": {
    "terminado_settings": { "shell_command": ["/bin/zsh", "-l"] }
  }
}
```

---

## Extensions

### Disable a labextension

**Surface:** page config
**File:** `labconfig/page_config.d/99-disable.json`

```json
{ "disabledExtensions": { "<plugin-id>": true } }
```

See [known-plugin-ids.md](known-plugin-ids.md) for a list of common targets (announcements, extension manager, debugger, table of contents, property inspector, notebook tools, …).

### Re-enable a labextension xtralab or ajlab disabled by default

```json
{ "disabledExtensions": { "<plugin-id>": false } }
```

The numeric prefix matters: name your file `99-user.json` so it loads after `00-xtralab.json`.

### List currently disabled extensions

```bash
jupyter labextension list
```

Disabled ones are flagged. Or open `Help → JupyterLab → About` in the running app.

---

## Language servers (jupyterlab-lsp)

xtralab ships Python (`ty`) and JavaScript/TypeScript pre-registered. To add another:

### Register Bash LSP

**Surface:** server config drop-in
**File:** `jupyter_server_config.d/99-bash-lsp.json`

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

Then `npm install -g bash-language-server` (or `pip install`, depending on the server). The LSP server binary must be on `$PATH`.

### Register Pyright instead of ty for Python

Same file pattern; LSP entry:

```json
{
  "pyright-langserver": {
    "version": 2,
    "argv": ["pyright-langserver", "--stdio"],
    "languages": ["python"],
    "mime_types": ["text/python", "text/x-python", "text/x-ipython"],
    "display_name": "pyright-langserver"
  }
}
```

Pre-baked specs (argv, mime types, etc.) for common servers: https://jupyterlab-lsp.readthedocs.io/en/latest/Language%20Servers.html

---

## Keyboard shortcuts

### Add a shortcut globally

**Surface:** default setting overrides (or user setting for a per-user one)
**File:** `labconfig/default_setting_overrides.d/99-shortcuts.json`

```json
{
  "@jupyterlab/shortcuts-extension:shortcuts": {
    "shortcuts": [
      {
        "command": "filebrowser:toggle-main",
        "keys": ["Ctrl B"],
        "selector": "body"
      }
    ]
  }
}
```

Command IDs: open the running app, command palette, search for the action, hover or check `Settings → Settings Editor → Keyboard Shortcuts` for the ID.

### Disable a shipped shortcut

Add an entry with `"disabled": true`:

```json
{
  "command": "notebook:run-cell",
  "keys": ["Shift Enter"],
  "selector": ".jp-Notebook:focus",
  "disabled": true
}
```

---

## Quiet-launch / "make it minimal"

xtralab already disables noisy plugins (announcements, extension manager, ToC, notebook tools, debugger, property inspector — see xtralab's `page_config.d/00-xtralab.json`). For vanilla JupyterLab, this snippet matches xtralab's quiet defaults:

**File:** `labconfig/page_config.d/99-quiet.json`

```json
{
  "disabledExtensions": {
    "@jupyterlab/apputils-extension:announcements": true,
    "@jupyterlab/apputils-extension:running-sessions-status": true,
    "@jupyterlab/extensionmanager-extension:plugin": true,
    "@jupyterlab/toc-extension:tracker": true,
    "@jupyterlab/notebook-extension:tools": true,
    "@jupyterlab/notebook-extension:update-raw-mimetype": true,
    "@jupyterlab/metadataform-extension:metadataforms": true,
    "@jupyterlab/debugger-extension:main": true,
    "@jupyterlab/application-extension:property-inspector": true
  }
}
```

---

## xtralab launcher

### Hide a built-in agent card (e.g. Kiro)

**Surface:** user setting
**File:** `lab/user-settings/xtralab/launcher.jupyterlab-settings`

```json5
{ agents: [{ id: 'kiro', enabled: false }] }
```

### Point Claude at a shell alias

```json5
{ agents: [{ id: 'claude', command: 'cl' }] }
```

Overriding a built-in agent's `command` skips the launcher's PATH availability
check for that card, so an aliased command (e.g. `cl`, or `ccm` for
`claude --effort=max …`) stays visible even though the alias is not on PATH. Use
`requireAvailable: false` only to skip the check without changing the command
(e.g. when you alias the `claude` binary name itself).

### Add a new agent card (Aider)

```json5
{
  agents: [{ id: 'aider', label: 'Aider', command: 'aider', promptArgs: [] }]
}
```

`promptArgs: []` → prompt becomes a positional arg. `["--prompt"]` → flagged. `null` → opt out of prompt-from-launcher.

### Add a new editor tile (Helix)

```json5
{
  editors: [
    {
      id: 'helix',
      label: 'Helix',
      command: 'hx',
      rank: -1,
      iconSvg: '<svg>…</svg>'
    }
  ]
}
```

The launcher shows one editor tile: the first available by `rank`.

---

## After making changes

- **Pip install:** restart `jupyter lab` (Ctrl-C in the terminal, run again).
- **xtralab desktop app:** quit (Cmd-Q / Alt-F4) and relaunch. The page-config and overrides are read at server start.
- **Verify:** open the in-app Settings Editor. Defaults you set via `default_setting_overrides.d/` show with a tooltip noting "system default"; user-settings show with the change indicator.
- **Diff after vs. before:** `git diff` your config dir if you keep it in source control.
