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

## Default settings

`xtralab` ships the following JupyterLab defaults:

- The announcements plugin is disabled, so JupyterLab does not prompt to fetch
  news from the Jupyter news feed and does not check for application updates.
- The Table of Contents, Debugger, and Notebook Tools panels are disabled so
  they do not show up in the right sidebar by default.

The JupyterLab frontend defaults are shipped as `labconfig/*.d/00-xtralab.json`
fragments so downstream meta-packages can add their own Lab configuration
fragments without replacing `xtralab`'s files.

## Install

```bash
pip install xtralab
```

## Development

```bash
# Install dependencies and the package in editable mode
uv pip install -e ".[dev]"
jlpm
jlpm build
```

## License

BSD-3-Clause
