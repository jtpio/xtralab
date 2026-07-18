# Screenshot suite

This folder regenerates the documentation screenshots with
[Galata](https://github.com/jupyterlab/jupyterlab/tree/main/galata),
JupyterLab's Playwright harness. It boots a real xtralab session against a
seeded demo workspace and writes the captures to
`../docs/src/assets/screenshots/`.

The seed script copies `fixtures/demo-project/` into `workspace/`, commits the
baseline versions from `fixtures/baseline/` with a fixed author and date, then
restores the working-tree edits on top. Every run therefore starts from the
same repository state: a modified `README.md` and `metrics.py`, plus an
untracked `forecast.py`.

## Run it

Set up the development environment first (see `../CONTRIBUTING.md`), so that
`.venv` exists and the labextension is built. Then:

```bash
cd ui-tests
pnpm install
pnpm install:browsers
pnpm screenshots
```

Playwright starts the server itself (port 8899) with an isolated Jupyter
config, forces the JupyterLab Dark theme in memory, and shuts everything down
afterwards.

## What is not regenerated

`hero.webp` and `terminals.webp` in the docs assets are curated captures that
include live coding-agent sessions, which a headless run cannot reproduce.
The agent buttons in the generated launcher screenshot reflect the agent CLIs
installed on the machine running the suite.
