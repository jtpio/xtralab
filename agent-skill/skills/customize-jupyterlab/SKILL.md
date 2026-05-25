---
name: customize-jupyterlab
description: Use this skill whenever the user wants to change how JupyterLab or xtralab looks or behaves — hide or show sidebar tabs, change the default theme, disable extensions, hide the status bar, move the activity bar, register a language server, tweak CodeMirror or notebook defaults, customize the xtralab launcher or sidebar, change keyboard shortcuts, edit context or menu items, set per-user defaults that survive reinstalls. Also use it when the user wants to _add_ new UI or behavior — a toolbar button, status-bar item, sidebar panel, custom command, menu entry, launcher card, file handler, mime renderer, or any "ad-hoc extension" — since those need a labextension, not a config tweak. Use it even when the user does not say "JupyterLab" or "xtralab" explicitly, as long as the context is a Jupyter notebook environment or the xtralab desktop app. Teaches the four config surfaces (page_config.d, default_setting_overrides.d, jupyter_server_config.d, lab/user-settings) and the fifth surface for runtime behavior (`share/jupyter/labextensions/`), how to find them with `jupyter --paths`, and where to write changes safely without touching installed package files.
compatibility: Requires JupyterLab 4+ and the `jupyter` CLI on PATH. Works with pip and conda installs, and with the xtralab desktop app (which sets `JUPYTER_CONFIG_DIR` to its own per-app directory).
---

# Customize JupyterLab

JupyterLab does not have one settings file — it has four layered config surfaces, each with its own format and discovery path. This skill maps a user request to the right surface, the right file, and the right location, then writes a small JSON snippet there. **Read [references/config-paths.md](references/config-paths.md) before editing anything.**

## Golden rules

1. **Never edit package-installed files.** Anything under `<venv>/lib/.../site-packages/...` or _existing_ directories under `<venv>/share/jupyter/...` (kernels, shipped labextensions, shipped schemas) is owned by packages and gets overwritten on reinstall. Two exceptions: (a) `<venv>/etc/jupyter/` is a config dir Jupyter searches, and you may write user snippets there (see rule 2); (b) _adding a new sub-directory_ under `<venv>/share/jupyter/labextensions/<your-name>/` is the intended install location for a federated labextension (see [references/adhoc-extensions.md](references/adhoc-extensions.md)).
2. **Pick the right config dir, by priority.** Run `jupyter --paths` and look at the **config** section. Treat that list as authoritative, then write to the first non-system writable config dir whose scope matches the request:
   1. **The active project environment's `etc/jupyter/`** (`<venv>/etc/jupyter/`, `$CONDA_PREFIX/etc/jupyter/`, or whatever `sys.prefix/etc/jupyter` resolves to) — **preferred when a normal project venv or conda env is active**. Scopes the customization to this project/env, travels with it, and is what users typically want when they're working inside a venv. Caveat: rebuilding the env (`rm -rf .venv && uv sync`, `conda env remove`, `pip install --force-reinstall jupyterlab`) wipes it. Tell the user this when you write here.
   2. **The user-config entry from `jupyter --paths`** — usually `~/.jupyter/`, but `JUPYTER_CONFIG_DIR` replaces this slot when it is set (xtralab desktop app, JupyterHub spawners, some Docker images). Use this when no project env is active, when the user wants the change to apply broadly, or when the active env path is a bundled/installed runtime rather than the user's project env.
   3. Never write to `/usr/local/etc/jupyter/` or `/etc/jupyter/` without explicit user/admin intent — those are system-wide.

   If you are unsure which of (1) and (2) the user wants, default to the env path when a normal project env is active and mention the trade-off in your reply. For the xtralab desktop app, write to its `JUPYTER_CONFIG_DIR` path, not the bundled runtime's `etc/jupyter/`.

3. **One concern per snippet file.** Prefer creating a new file like `99-user-theme.json` next to existing files rather than editing a shipped `00-xtralab.json` or `00-ajlab.json`. JupyterLab merges all `*.json` files in a `*.d/` directory; lexical order breaks ties, so `99-` wins.
4. **Validate JSON before saving.** A malformed file silently disables every snippet in the directory.
5. **Restart JupyterLab** after writing. The browser-side `Settings → Settings Editor` UI shows user-settings live; `page_config.d/` and `default_setting_overrides.d/` need a server restart. For the xtralab desktop app: quit and relaunch.

## The four config surfaces

| Surface                       | Path pattern (under a config dir)                                             | Use for                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Page config**               | `labconfig/page_config.d/*.json`                                              | Disable or re-enable extensions, set page-level flags (theme name when no user setting, devmode, etc.)                                                         |
| **Default setting overrides** | `labconfig/default_setting_overrides.d/*.json`                                | Change the default value of _any_ JupyterLab plugin setting (theme, shell layout, codemirror, completer, git, terminal, …). User settings still win over this. |
| **Jupyter server config**     | `jupyter_server_config.d/*.json` (plus the larger `jupyter_server_config.py`) | Enable a server extension, register a language server for `jupyterlab-lsp`, set tornado/server traits                                                          |
| **User settings**             | `lab/user-settings/<plugin-id>/<setting>.jupyterlab-settings`                 | Per-user override of one specific setting; highest priority. Written by the in-app Settings Editor but you can drop files here too.                            |

A user request usually maps to _one_ of these. If you are not sure, default to **setting overrides** for visible JupyterLab behavior and **page config** for hiding extensions entirely. See [references/recipes.md](references/recipes.md) for the mapping per request type.

## When customization needs code: ad-hoc labextensions

The four config surfaces above can only reshape what JupyterLab already exposes. To **add** new behavior — a toolbar button, a status-bar item, a sidebar panel, a custom command, a launcher card, a file handler, a mime renderer — you have to ship a labextension.

This is a fifth surface, and it does not need a full TypeScript / pip-package setup. A labextension is a directory under `<prefix>/share/jupyter/labextensions/<name>/` containing a `package.json` and a JS file that registers a webpack-module-federation container on `window._JUPYTERLAB[<name>]`. JupyterLab discovers it at server startup and loads it like any other federated extension. For the common case (consuming only packages JupyterLab already ships — anything in `@jupyterlab/*` or `@lumino/*`), you can hand-write the container in plain JS — no build, no `node_modules`.

**Decide config vs. extension** with the table in [references/adhoc-extensions.md](references/adhoc-extensions.md). Anything phrased as "add", "new", "custom", or describing behavior that does not exist yet is an extension request. Read that reference before scaffolding — it has the full federation contract, the plugin object shape, ready-to-use patterns (toolbar button, command + palette + shortcut, status-bar item, sidebar, launcher, file type, mime renderer), and the gotchas (sync factory requirement, shared-scope token identity, etc.).

## Workflow

For every customization request:

1. **Locate the writable config dir, following the priority in rule 2 above.** Run `jupyter --paths`. Prefer the active project env's `etc/jupyter/` when it is a normal venv/conda env; otherwise use the user-config entry shown by `jupyter --paths` (`JUPYTER_CONFIG_DIR` when set, `~/.jupyter/` otherwise). When you write to an env path, tell the user the customization is scoped to that env and will be lost if the env is rebuilt.
2. **Decide the surface.** Look up the recipe in [references/recipes.md](references/recipes.md). If the request is "hide thing X from the UI", grep [references/known-plugin-ids.md](references/known-plugin-ids.md) for X first — disabling the plugin is usually the cleanest path.
3. **Read the existing file in that surface, if any.** If you are about to overwrite a shipped file, stop and write a new `99-*.json` instead.
4. **Write the smallest JSON snippet that does the job.** Do not copy adjacent settings you are not changing.
5. **Tell the user to restart** JupyterLab (or the desktop app), and to verify with `Help → JupyterLab → About` showing the disabled extensions or with `Settings → Settings Editor`.

## xtralab-specific knobs

If the user is on xtralab (not vanilla JupyterLab), some requests have a dedicated setting that is friendlier than disabling plugins. The full settings UI is at `Settings → Settings Editor → xtralab …`:

- **Sidebar tab visibility** (default file browser, running sessions): `xtralab:sidebar` settings — `showDefaultFileBrowser`, `showRunningSessions`. Prefer this over `page_config.disabledExtensions` because it preserves discoverability via the View menu.
- **Launcher agents and editors**: `xtralab:launcher` — `agents[]` and `editors[]` arrays merge with built-ins by `id`. See xtralab's README for the schema; set `enabled: false` to hide a default agent, or add a new entry to introduce one.
- **File browser context menu**: defined in xtralab's `schema/plugin.json`. The shipped menu is opinionated; users override entries by writing user-settings for `xtralab:plugin`.

Write xtralab-specific overrides to the _same_ user config dir, as `default_setting_overrides.d/99-xtralab-user.json` or as a `lab/user-settings/xtralab/<name>.jupyterlab-settings` file.

## When to ask vs. when to act

- **Act directly** for unambiguous requests with a clear recipe (hide status bar, change theme to dark, disable announcements).
- **Confirm** when the request affects multiple surfaces (e.g. "make JupyterLab minimal") — list the changes you would make first, then write on approval.
- **Stop and ask** if `jupyter --paths` shows no writable user dir, or if the user appears to be in a Docker/JupyterHub setup where the right path is image-specific.

## Gotchas

These are JupyterLab-specific traps that an agent will fall into without warning:

- **`page_config.d/` and `default_setting_overrides.d/` are read at server start, not at page reload.** A browser refresh will not pick up the change. The user has to restart `jupyter lab` (or quit and relaunch the xtralab desktop app).
- **The xtralab desktop app does not read `~/.jupyter/`.** It sets `JUPYTER_CONFIG_DIR` to a per-app directory (`~/Library/Application Support/xtralab/jupyter/config/` on macOS, `~/.config/xtralab/jupyter/config/` on Linux). Writing to `~/.jupyter/` has no effect on the desktop app — always confirm with `jupyter --paths` from inside the running environment.
- **User-settings filenames split the plugin ID on `:`.** Plugin ID `xtralab:launcher` lives at `lab/user-settings/xtralab/launcher.jupyterlab-settings`, _not_ `lab/user-settings/xtralab:launcher.jupyterlab-settings`. The directory is the part before the colon; the filename is the part after, with extension `.jupyterlab-settings`.
- **`disabledExtensions: { "<id>": false }` re-enables a plugin that a lower-priority file disabled.** Omitting the entry is not the same as setting it to `false` — to revert xtralab's `00-xtralab.json` disabling the debugger, write a `99-user.json` with `false` explicitly.
- **Three priority layers can silently hide your change.** From highest to lowest: a `lab/user-settings/...jupyterlab-settings` file, then `default_setting_overrides.d/*.json` (lexically last wins), then the plugin's schema default. And `page_config.d/`'s `disabledExtensions` short-circuits all of this — a disabled plugin ignores every setting. If a change "doesn't apply", check each layer in that order.
- **`jupyter.lab.menus` and `jupyter.lab.shortcuts` overrides merge with shipped items, they don't replace them.** To remove a menu entry, use `{ "id": "...", "disabled": true }`, not omission.
- **LSP servers must be on `$PATH` for the Jupyter Server process.** Registering a server in `jupyter_server_config.d/` only tells `jupyterlab-lsp` how to spawn it; the binary itself must already be installed and resolvable from the Jupyter server's environment (not just the user's shell — these differ for the desktop app and for some launcher setups).
- **`jupyter labextension list` shows package names, not plugin IDs.** A package like `@jupyterlab/notebook-extension` contributes multiple plugins (`:tracker`, `:tools`, `:completer`, …). To find the exact ID a `disabledExtensions` key needs, open `Help → JupyterLab → About` in the running app, or grep the extension's `schemas/*.json` files in `share/jupyter/lab/schemas/`.
- **Settings written by the in-app Settings Editor land in `lab/user-settings/`, not in `default_setting_overrides.d/`.** Changes the user makes through the UI are per-user; they do not propagate to other users on the same machine and they win over any default you set in `default_setting_overrides.d/`.

## Verify after writing

After every change, tell the user to:

1. Restart JupyterLab (`Ctrl-C` and rerun `jupyter lab`) or quit + relaunch the desktop app.
2. Open `Help → JupyterLab → About` to confirm the expected plugin appears disabled / enabled.
3. For settings changes: open `Settings → Settings Editor → <plugin name>` — defaults set via `default_setting_overrides.d/` show with a tooltip noting "system default".
4. For LSP changes: open a file matching the registered language and confirm `Settings → LSP` shows the server as connected.

If the change does not appear, walk the [three priority layers](#gotchas) before re-editing the file.

## Discovery quick reference

```bash
# Where do configs live?
jupyter --paths

# Which lab extensions are installed (and disabled)?
jupyter labextension list

# Which server extensions are enabled?
jupyter server extension list

# Which language servers does jupyterlab-lsp know about?
# (look at the LanguageServerManager.language_servers section)
jupyter server --debug 2>&1 | head -200
```

## References

- [references/config-paths.md](references/config-paths.md) — full path tree for pip, conda, Docker, JupyterHub, xtralab desktop app; what is writable, what is not, and what `JUPYTER_CONFIG_DIR` overrides.
- [references/recipes.md](references/recipes.md) — cookbook of common requests with the exact file, location, and JSON to write.
- [references/known-plugin-ids.md](references/known-plugin-ids.md) — plugin IDs for the most commonly toggled JupyterLab extensions (status bar, announcements, extension manager, debugger, ToC, property inspector, notebook tools, …) and the xtralab plugins.
- [references/adhoc-extensions.md](references/adhoc-extensions.md) — how to ship an ad-hoc labextension without a full build: the federation container contract, hand-written skeleton, common patterns (toolbar button, command, status-bar item, sidebar, launcher, file type, mime renderer), three build approaches, gotchas.

## Upstream documentation

- JupyterLab directories (config tree, `page_config.json`, `overrides.json`): https://jupyterlab.readthedocs.io/en/latest/user/directories.html#labconfig-directories
- Default-setting overrides format: https://jupyterlab.readthedocs.io/en/latest/user/directories.html#overrides-json
- Enabling and disabling extensions (priority order, `disabledExtensions`): https://jupyterlab.readthedocs.io/en/latest/user/extensions.html
- Jupyter Server configuration (config files, drop-in `.d/` directories): https://jupyter-server.readthedocs.io/en/latest/operators/configuring-extensions.html
- jupyterlab-lsp language server configuration: https://jupyterlab-lsp.readthedocs.io/en/latest/Configuring.html
- jupyterlab-lsp pre-baked language server specs (Python, TypeScript, R, …): https://jupyterlab-lsp.readthedocs.io/en/latest/Language%20Servers.html
- xtralab README (launcher and sidebar settings): https://github.com/jtpio/xtralab
