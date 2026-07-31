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

## The agent captures

`hero.png` (the landing page) and `terminals.png` (the terminals panel) run
live coding-agent sessions through the launcher's own commands: the hero
launches Claude Code, and the terminals capture launches Codex, Claude Code,
and GitHub Copilot side by side. These tests need the `claude`, `codex`, and
`copilot` CLIs installed and are skipped when one is missing. On a machine
that has never run an agent in the seeded workspace, the tests accept the
agents' one-time trust prompts on their own. The agent buttons in the
launcher and hero captures reflect the agent CLIs installed on the machine
running the suite.

## README images

The images referenced by the repository README are down-scaled copies of two
of the captures:

```bash
cwebp -q 90 -resize 2400 0 ../docs/src/assets/screenshots/hero.png -o ../images/hero.webp
cwebp -q 90 -resize 2400 0 ../docs/src/assets/screenshots/launcher.png -o ../images/launcher.webp
```
