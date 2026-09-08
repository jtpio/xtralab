# Known plugin IDs

Plugin IDs to put in `page_config.d/*.json` `disabledExtensions` (set to `true` to hide, `false` to re-enable) and in `default_setting_overrides.d/*.json` (as top-level keys, when configuring rather than disabling).

The list below is curated for "things a user might want to toggle off" — not exhaustive. To discover any plugin's ID, open `Help → JupyterLab → About` in the running app, or `Settings → Settings Editor` and read the URL fragment.

## Disable-friendly plugins (UI noise)

| What it shows                                          | Plugin ID                                                |
| ------------------------------------------------------ | -------------------------------------------------------- |
| Status bar at the bottom                               | `@jupyterlab/statusbar-extension:plugin`                 |
| Announcement banner (new versions, etc.)               | `@jupyterlab/apputils-extension:announcements`           |
| "Running sessions" status indicator                    | `@jupyterlab/apputils-extension:running-sessions-status` |
| Extension Manager left-sidebar tab                     | `@jupyterlab/extensionmanager-extension:plugin`          |
| Table of Contents left-sidebar tab                     | `@jupyterlab/toc-extension:tracker`                      |
| Notebook Tools / cell metadata sidebar                 | `@jupyterlab/notebook-extension:tools`                   |
| Property Inspector right-sidebar tab                   | `@jupyterlab/application-extension:property-inspector`   |
| Debugger right-sidebar icon and panel                  | `@jupyterlab/debugger-extension:main`                    |
| Cell metadata form ("Common Tools")                    | `@jupyterlab/metadataform-extension:metadataforms`       |
| "Update raw cell mimetype" toolbar item                | `@jupyterlab/notebook-extension:update-raw-mimetype`     |
| The JupyterLab logo in the top bar                     | `@jupyterlab/application-extension:logo`                 |
| Vim mode                                               | `@axlair/jupyterlab_vim`                                 |
| Default file browser (left sidebar)                    | `@jupyterlab/filebrowser-extension:browser`              |
| Running terminals and kernels tab                      | `@jupyterlab/running-extension:plugin`                   |
| Main menu bar (use carefully — disables menu entirely) | `@jupyterlab/mainmenu-extension:plugin`                  |

xtralab already disables many of these via its shipped `00-xtralab.json` page-config — confirm before duplicating an entry.

## Settings-rich plugins (configure, not disable)

These are the plugins users most often configure in `default_setting_overrides.d/`:

| Plugin ID                                   | Common keys                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@jupyterlab/apputils-extension:themes`     | `theme`, `adaptive-theme`, `theme-scrollbars`                                                                                                           |
| `@jupyterlab/application-extension:shell`   | `startMode`, `activityBarPosition`, `dockPanelPadding`, `layout.{single,multiple}`                                                                      |
| `@jupyterlab/codemirror-extension:plugin`   | `defaultConfig.{lineWrap,autoClosingBrackets,codeFolding,highlightActiveLine,highlightTrailingWhitespace,scrollPastEnd,lineNumbers,indentUnit,tabSize}` |
| `@jupyterlab/notebook-extension:tracker`    | `recordTiming`, `codeCellConfig.{lineNumbers,...}`, `markdownCellConfig`, `rawCellConfig`                                                               |
| `@jupyterlab/filebrowser-extension:browser` | `showHiddenFiles`, `sortNotebooksFirst`, `singleClickNavigation`                                                                                        |
| `@jupyterlab/terminal-extension:plugin`     | `fontFamily`, `fontSize`, `lineHeight`, `theme`                                                                                                         |
| `@jupyterlab/completer-extension:manager`   | `autoCompletion`, `showDocumentationPanel`, `providerTimeout`                                                                                           |
| `@jupyter-lsp/jupyterlab-lsp:completion`    | `continuousHinting`, `caseSensitive`, `kernelResponseTimeout`                                                                                           |
| `@jupyter-lsp/jupyterlab-lsp:plugin`        | `language_servers`, `loggingLevel`, `setTrace`                                                                                                          |
| `@jupyterlab/git:plugin`                    | `fileClickAction`, `disableBranchWithChanges`, `simpleStaging`, `historyCount`, `commitAndPush`                                                         |
| `@jupyterlab/shortcuts-extension:shortcuts` | `shortcuts[]` (array of `{command, keys, selector, disabled?}`)                                                                                         |
| `jupyterlab-quickopen:plugin`               | `respectGitignore`, `excludes`, `includes`                                                                                                              |

## xtralab plugins

| Plugin ID          | What it controls                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `xtralab:launcher` | Agent and editor cards (`agents[]`, `editors[]`); see xtralab README                                                     |
| `xtralab:sidebar`  | `showTerminals`, `showFileBrowser`, `showGitPanel`, `showDefaultFileBrowser`, `showRunningSessions`, `showSearchReplace` |
| `xtralab:plugin`   | File-browser context menu, top-level xtralab commands                                                                    |
| `xtralab:omnibox`  | `maxNumberRecents` (recently used commands and files shown on open)                                                      |

## Plugin ID structure

A JupyterLab plugin ID always has the form `<npm-package-name>:<plugin-key>`. The `:plugin` suffix is conventional but not required — extensions can register multiple plugins per package.

- `@jupyterlab/notebook-extension:tracker` → package `@jupyterlab/notebook-extension`, plugin `tracker`
- `@jupyter-lsp/jupyterlab-lsp:completion` → package `@jupyter-lsp/jupyterlab-lsp`, plugin `completion`

## Finding the right ID

1. In the running app: `Help → JupyterLab → About` lists every loaded plugin and its ID.
2. `Settings → Settings Editor` shows one section per _settable_ plugin; the URL fragment is the ID.
3. Source: each labextension's `schema/*.json` files declare the IDs and their settable properties. For xtralab the schemas are at `schema/{plugin,launcher,sidebar}.json` in the repo.
4. `jupyter labextension list --debug` prints package names; combine with the package's source to find plugin keys.
