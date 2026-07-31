# Screenshot suite

This folder regenerates the documentation screenshots with
[Galata](https://github.com/jupyterlab/jupyterlab/tree/main/galata),
JupyterLab's Playwright harness. It boots a real xtralab session against a
seeded demo workspace and writes the captures to
`../docs/src/assets/screenshots/`.

The seed script copies `fixtures/demo-project/` into
`~/.cache/xtralab-screenshots/` (outside the repository, so the absolute path
that shows up in captured terminal output reads the same on every machine and
checkout), commits the baseline versions from `fixtures/baseline/` with a
fixed author and date, then restores the working-tree edits on top. Every run
therefore starts from the same repository state: a modified `README.md` and
`metrics.py`, plus an untracked `forecast.py`.

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
config, forces the Pierre Dark theme in memory, and shuts everything down
afterwards.

## The hero capture

`hero.png`, the landing-page screenshot, launches a real Claude Code session
through the launcher's own command, so it needs the `claude` CLI installed —
the test is skipped when the CLI is missing. On a machine that has never run
claude in the seeded workspace, the test accepts claude's one-time
folder-trust prompt on its own. The agent buttons in the launcher and hero
captures reflect the agent CLIs installed on the machine running the suite.

## What is not regenerated

`terminals.webp` in the docs assets is a curated capture of several live
coding-agent sessions side by side, which the suite does not reproduce.

The images referenced by the repository README are down-scaled copies of two
of the captures:

```bash
cwebp -q 90 -resize 2400 0 ../docs/src/assets/screenshots/hero.png -o ../images/hero.webp
cwebp -q 90 -resize 2400 0 ../docs/src/assets/screenshots/launcher.png -o ../images/launcher.webp
```
