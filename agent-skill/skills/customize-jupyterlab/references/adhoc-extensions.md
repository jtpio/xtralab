# Ad-hoc labextensions

When a customization request needs _runtime behavior_ — adding a toolbar button, a sidebar panel, a status-bar item, a command, a menu entry, a custom widget — config files cannot do it. You need a **labextension**.

A labextension is just a directory under `<prefix>/share/jupyter/labextensions/<name>/`. JupyterLab discovers it at server startup, loads a JS file out of it via a `<script>` tag, and registers the plugin(s) it exposes. **No build is required for the common case** — you can hand-write a webpack-module-federation container in plain JS.

## When extension vs. config?

| Want to …                                                                                                      | Use                                   |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Hide / show a built-in plugin                                                                                  | **page config** `disabledExtensions`  |
| Change a setting's default                                                                                     | **default setting overrides**         |
| Register an LSP server                                                                                         | **server config**                     |
| Add a toolbar button, status-bar item, sidebar panel, command, menu entry, custom widget, file type handler, … | **ad-hoc extension** (this reference) |

If a request asks to _add_ something the UI does not have, or describes new behavior, it's an extension. Settings can only re-shape what already exists.

## Where to install

Drop the directory under `<prefix>/share/jupyter/labextensions/<name>/`, where `<prefix>` is one of (in priority order from `jupyter --paths`'s **data** section):

1. **Active env's data dir** — `.venv/share/jupyter/labextensions/`, `$CONDA_PREFIX/share/jupyter/labextensions/`, etc. Scopes to env; wiped on env rebuild.
2. **User data dir** — `~/Library/Jupyter/labextensions/` (macOS), `~/.local/share/jupyter/labextensions/` (Linux). Survives env rebuilds.
3. **`JUPYTER_DATA_DIR`** if set, or the xtralab desktop app's per-app data dir.

Adding a _new sub-directory_ here is the intended install location for federated extensions — this is the one exception to the general "don't write under `share/jupyter/`" rule (you are not modifying any package's files).

## Directory contract

Minimum layout:

```
labextensions/<name>/
├── package.json          ← read by jupyter-server at startup
├── install.json          ← optional, cosmetic for `jupyter labextension list`
└── static/
    └── remoteEntry.js    ← the federation container
```

`package.json`:

```json
{
  "name": "<name>",
  "version": "0.1.0",
  "description": "...",
  "jupyterlab": {
    "extension": true,
    "_build": {
      "load": "static/remoteEntry.js",
      "extension": "./extension"
    }
  }
}
```

Fields under `jupyterlab`:

- `extension`: `true` for a plugin extension. Set to `false` if this package only contributes CSS / a mime renderer.
- `_build.load`: relative path (from the extension dir) to the federation container JS. Webpack output uses a hash (`remoteEntry.5cbb9d2323598fbda535.js`); for hand-written ones use a stable name.
- `_build.extension`: the module name passed to `container.get()` to retrieve the plugin module. Conventionally `"./extension"`.
- `_build.style`: optional module name for a CSS entry.
- `_build.mimeExtension`: set for mime-renderer extensions (e.g. a custom output renderer).

`install.json` (cosmetic — affects only how `jupyter labextension list` labels it):

```json
{
  "packageManager": "ad-hoc",
  "packageName": "<name>",
  "uninstallInstructions": "Remove the directory at <prefix>/share/jupyter/labextensions/<name>"
}
```

JupyterLab's server reads `package.json` directly and serves the directory at `/<base_url>lab/extensions/<name>/...`. There is no `node_modules`, no `package-lock.json`, no install step.

## The federation container

JupyterLab loads the container via (`jupyterlab/staging/bootstrap.js`):

```js
await loadScript(`${labExtensionsUrl}/${name}/${load}`);
const container = window._JUPYTERLAB[name];
await container.init(__webpack_share_scopes__.default);
const factory = await container.get(extension); // extension = "./extension"
const instance = factory(); // sync — instance.default is the plugin or array of plugins
```

So `remoteEntry.js` must:

1. Register `window._JUPYTERLAB[<name>]` = `{ init, get }`.
2. `init(scope)` is async; it receives the host's webpack shared scope. Save it for later.
3. `get(moduleName)` is async; it returns a **synchronous** factory function. The factory returns `{ __esModule: true, default: <plugin or [plugins]> }`.

Critical: the factory is called synchronously by JupyterLab. Do all shared-module loading inside `get` _before_ returning the factory.

### Skeleton (hand-written, no build)

```js
(function () {
  const NAME = 'my-extension';
  let sharedScope = null;

  async function consumeShared(pkg) {
    const versions = sharedScope && sharedScope[pkg];
    if (!versions) throw new Error('shared module not in scope: ' + pkg);
    // Pick highest version; for ad-hoc single-host use, first key is fine.
    const factory = await versions[Object.keys(versions)[0]].get();
    return factory();
  }

  const moduleMap = {
    './extension': async function () {
      // Load every host package you need, here.
      const apputils = await consumeShared('@jupyterlab/apputils');
      const { showDialog, Dialog, ToolbarButton } = apputils;

      const plugin = {
        id: 'my-extension:plugin',
        description: '...',
        autoStart: true,
        activate: function (app) {
          // your code
        }
      };
      return { __esModule: true, default: plugin };
    }
  };

  const container = {
    init: async function (scope) {
      sharedScope = scope;
    },
    get: async function (moduleName) {
      const loader = moduleMap[moduleName];
      if (!loader) throw new Error('unknown module: ' + moduleName);
      const exports = await loader();
      return function factory() {
        return exports;
      };
    }
  };

  const root = typeof window !== 'undefined' ? window : self;
  root._JUPYTERLAB = root._JUPYTERLAB || {};
  root._JUPYTERLAB[NAME] = container;
})();
```

### Shared scope: what is available

JupyterLab shares every package in `jupyterlab/staging/package.json`'s `resolutions` block. In practice: everything in `@jupyterlab/*` and `@lumino/*` is consumable from your container.

To enumerate on a given install:

```bash
node -e "const r=require('<venv>/lib/python<X>/site-packages/jupyterlab/staging/package.json').resolutions; \
  console.log(Object.keys(r).filter(k=>k.startsWith('@jupyterlab/')||k.startsWith('@lumino/')).sort().join('\n'))"
```

If you need an npm package JupyterLab does _not_ ship (e.g. `lodash`, `d3`), you cannot consume it from the shared scope — you must bundle it. At that point, drop the hand-written approach and use `jupyter labextension build` (see "Three build approaches" below).

## The plugin object

```js
{
  id: 'my-extension:plugin',  // required, conventionally '<pkg>:<name>'
  description: '...',         // optional, shown in Help → JupyterLab → About
  autoStart: true,            // start without explicit activation
  requires: [Token1, ...],    // hard deps — passed in order to activate
  optional: [Token2, ...],    // optional deps — null if not present
  provides: ITokenIExpose,    // optional, what this plugin contributes
  activate: (app, dep1, dep2) => {
    // do stuff. Return value satisfies `provides`.
  }
}
```

The module's `default` can be a single plugin or an array — JupyterLab handles both.

`app` is a `JupyterFrontEnd`. The most-used handles:

- `app.commands` — register / execute commands (`CommandRegistry`).
- `app.shell` — add widgets to areas (`'top' | 'left' | 'right' | 'bottom' | 'main' | 'header' | 'menu'`).
- `app.docRegistry` — register widget extensions, file types, document factories.
- `app.serviceManager` — kernels, sessions, settings, etc.
- `app.restored` — Promise that resolves when the layout is ready.

## Common patterns

### Notebook toolbar button — preferred (no token needed)

```js
activate: app => {
  app.docRegistry.addWidgetExtension('Notebook', {
    createNew(panel /* NotebookPanel */) {
      const button = new ToolbarButton({
        label: 'X',
        tooltip: '…',
        onClick: () => {
          /* … */
        }
      });
      panel.toolbar.insertItem(10, 'myButton', button);
      return button; // IDisposable — called when the notebook closes
    }
  });
};
```

### Notebook toolbar button — via tracker (when you need to react to other widget state)

`requires: [INotebookTracker]` from `@jupyterlab/notebook`:

```js
activate: (app, tracker) => {
  const add = panel => {
    /* same as createNew body */
  };
  tracker.widgetAdded.connect((_, panel) => add(panel));
  tracker.forEach(add);
};
```

Prefer `addWidgetExtension` when you just want a button per notebook — no extra dependency.

### Command + palette + keybinding

`requires: [ICommandPalette]` from `@jupyterlab/apputils`:

```js
activate: (app, palette) => {
  const id = 'my-extension:do-thing';
  app.commands.addCommand(id, {
    label: 'Do thing',
    execute: () => {
      /* … */
    }
  });
  palette.addItem({ command: id, category: 'My category' });
  app.commands.addKeyBinding({
    command: id,
    keys: ['Ctrl Shift X'],
    selector: 'body'
  });
};
```

### Menu entry

`requires: [IMainMenu]` from `@jupyterlab/mainmenu`:

```js
activate: (app, mainMenu) => {
  mainMenu.fileMenu.addItem({
    type: 'command',
    command: 'my-extension:do-thing'
  });
};
```

### Status-bar item

`requires: [IStatusBar]` from `@jupyterlab/statusbar`. Note the status bar plugin may be disabled (xtralab disables it by default — see `known-plugin-ids.md`); use `optional: [IStatusBar]` if you want to degrade gracefully.

```js
const { Widget } = await consumeShared('@lumino/widgets');
const widget = new Widget();
widget.node.textContent = 'hi';
statusBar.registerStatusItem('my-extension:item', {
  item: widget,
  align: 'right'
});
```

### Sidebar panel

```js
const { Widget } = await consumeShared('@lumino/widgets');
const w = new Widget();
w.id = 'my-extension-sidebar';
w.title.label = 'My Panel';
w.title.iconClass = 'jp-SideBar-tabIcon';
app.shell.add(w, 'left'); // or 'right'
```

For a React panel, consume `ReactWidget` from `@jupyterlab/ui-components` and pass a render function.

### Launcher item

`requires: [ILauncher]` from `@jupyterlab/launcher`:

```js
launcher.add({
  command: 'my-extension:do-thing',
  category: 'Other',
  rank: 1
});
```

### File type / handler

```js
app.docRegistry.addFileType({
  name: 'my-type',
  displayName: 'My File',
  extensions: ['.myx'],
  mimeTypes: ['application/x-my'],
  contentType: 'file'
});
```

Pair with `app.docRegistry.addWidgetFactory(...)` to open it in a custom widget.

### Mime renderer (custom output for a MIME type)

Set `jupyterlab._build.mimeExtension` to `"./mimeExtension"` and export from that module:

```js
const mimeRenderer = {
  id: 'my-extension:mime',
  rendererFactory: {
    safe: true,
    mimeTypes: ['application/x-my'],
    createRenderer: options => new MyRenderer(options)
  },
  rank: 0,
  dataType: 'string'
};
```

## Three build approaches

| Approach                                           | When                                                                               | Cost                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Hand-written, no build**                         | Plugin only consumes `@jupyterlab/*` / `@lumino/*`; small JS; no TypeScript needed | Zero — write JS, drop into `labextensions/`, restart server                                             |
| **`jupyter labextension build` from a source dir** | Want TypeScript, modest external deps, still ad-hoc (no pip package)               | Need a source dir with `package.json` declaring `@jupyter/builder` as devDep; one-time `jlpm install`   |
| **Full pip-packaged extension**                    | Distributing to others, want `pip install` to wire everything                      | Cookiecutter `copier copy https://github.com/jupyterlab/extension-template my-ext`, TS + Python wrapper |

**Default to (1)** for ad-hoc requests in this repo. Drop to (2) only when TS or a non-JupyterLab npm dep is genuinely needed. Reserve (3) for shippable extensions.

For (2), the source `package.json` needs:

```json
{
  "name": "my-extension",
  "version": "0.1.0",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "scripts": {
    "build": "tsc && jupyter labextension build ."
  },
  "dependencies": { "@jupyterlab/application": "^4.0.0" },
  "devDependencies": {
    "@jupyter/builder": "^1.0.0",
    "typescript": "~5.0.0"
  },
  "jupyterlab": {
    "extension": true,
    "outputDir": "<absolute path to share/jupyter/labextensions/my-extension>"
  }
}
```

Then `jlpm install && jlpm build` writes the federation bundle directly into the install path. JupyterLab's builder marker resolution falls back to `@jupyterlab/builder` if `@jupyter/builder` is not declared (see `jupyter_builder/federated_extensions.py:_select_builder_marker`).

## Verify

```bash
jupyter labextension list
# expect: <name> vX.Y.Z enabled OK (...)
```

If listed but does nothing:

- Open browser DevTools → Console. Look for `Failed to create module: package: <name>; module: ./extension` — that's a runtime error in your `get()`.
- Confirm `window._JUPYTERLAB['<name>']` exists and has `init` + `get`.
- Visit `http://<host>:<port>/lab/extensions/<name>/static/remoteEntry.js` to confirm the file is served.
- Check `Help → JupyterLab → About` — the extension's plugins show up by ID.

If listed but **disabled**: check `page_config.json` / `page_config.d/` for `disabledExtensions` entries; an explicit `false` overrides them.

## Gotchas

- **Server discovery happens once, at startup.** Changes to `package.json` or adding a new extension dir require a Lab restart. Edits to the JS itself are picked up on a browser reload.
- **`window._JUPYTERLAB[name]` key must match `package.json:name` exactly.** Scoped packages (`@you/foo`) keep the slash in the key.
- **The factory returned by `get()` must be sync.** Resolve all shared modules _before_ returning it. An async factory causes JupyterLab's `factory()` call to receive a Promise instead of the module — silent failure.
- **`Object.keys(versions)[0]` picks an arbitrary version.** Fine for ad-hoc single-host. If you need semver picking, sort with the rules in `@jupyterlab/coreutils`'s `SemverRange`.
- **Don't `import` anything in `remoteEntry.js`.** It is loaded as a plain `<script>` tag, not as an ES module. Use globals or consume from `sharedScope`.
- **CSS:** the easiest hack for ad-hoc extensions is to inject a `<style>` element from `activate`. For a "real" entry, set `jupyterlab._build.style` to a module name and serve CSS through it (the build approach handles this for you).
- **Lumino, not React, by default.** `app.shell.add` wants a `Widget` from `@lumino/widgets`. For React, wrap with `ReactWidget` from `@jupyterlab/ui-components`.
- **Tokens must come from the host.** Importing `INotebookTracker` from a bundled copy of `@jupyterlab/notebook` gives you a _different_ token object than the host's — `requires: [INotebookTracker]` then fails to match. Always consume the token from the shared scope, never bundle the package.
- **Two extensions cannot share `_JUPYTERLAB[name]`.** The name in `package.json` must be unique per install.
- **`jupyter labextension develop --overwrite`** (the standard dev workflow for built extensions) symlinks _into_ `share/jupyter/labextensions/`. It does not apply to hand-written ad-hoc extensions — just create the directory directly.

## Upstream documentation

- Extension developer overview: https://jupyterlab.readthedocs.io/en/latest/extension/extension_dev.html
- Federated extension internals (the contract this reference codifies): https://jupyterlab.readthedocs.io/en/latest/extension/extension_dev.html#federated-extensions
- Plugin / tokens: https://jupyterlab.readthedocs.io/en/latest/extension/extension_points.html
- The cookiecutter / `extension-template` for full-build extensions: https://github.com/jupyterlab/extension-template
- Module federation (webpack docs the contract follows): https://webpack.js.org/concepts/module-federation/
