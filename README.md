![xtralab-logo](./logo.png)

An opinionated JupyterLab meta-package for coding agents.

xtralab reshapes JupyterLab around terminal coding agents. It bundles a curated
set of extensions, a path-first file browser, rich git diffs, an agent launcher,
a Model Context Protocol server that lets agents drive the app, and a quieter
set of defaults. It builds on [`ajlab`](https://github.com/jtpio/ajlab), the
agent-ready JupyterLab base.

![The xtralab workspace: path-first file browser, agent launcher, a side-by-side git diff, and a running Claude Code session](./images/hero.webp)

The [documentation](https://jtpio.github.io/xtralab/) covers everything in
detail: [installation](https://jtpio.github.io/xtralab/installation/), a
[tour of the features](https://jtpio.github.io/xtralab/getting-started/),
[connecting agents over MCP](https://jtpio.github.io/xtralab/agents/mcp/),
[agent skills](https://jtpio.github.io/xtralab/agents/skills/), and the
[desktop app](https://jtpio.github.io/xtralab/desktop/).

## Install

```bash
pip install xtralab
jupyter lab
```

A standalone desktop app (DMG on macOS, AppImage on Linux) ships with every
tagged release on the
[releases page](https://github.com/jtpio/xtralab/releases/latest); see the
[desktop app docs](https://jtpio.github.io/xtralab/desktop/) for the
Gatekeeper notes and how it manages projects and kernels.

## Highlights

![The xtralab launcher](./images/launcher.webp)

The launcher starts any agent installed on your machine, with an optional
prompt and a **Changes** list that jumps straight into a side-by-side git diff
you can edit in place. Select code in an editor, a notebook, or a diff to send
a prompt about it to a new or already-running agent, or queue prompts while
you read. One omnibox searches files and commands, the Terminals panel shows
which agent runs where, and quieter defaults keep the workspace calm. The
[documentation](https://jtpio.github.io/xtralab/) walks through each of these.

## Connecting agents to JupyterLab (MCP)

xtralab runs a [Model Context Protocol][mcp-spec] server inside JupyterLab,
provided by [`jupyter-server-mcp`][mcp], so an agent can open files, run
cells, and read notebooks. Register the bundled proxy from a terminal inside
xtralab:

```bash
claude mcp add jupyter -- jupyter-server-mcp-proxy
```

The launcher surfaces the matching command for every agent you have
installed, and the [MCP docs page](https://jtpio.github.io/xtralab/agents/mcp/)
covers the details.

[mcp]: https://github.com/jupyter-ai-contrib/jupyter-server-mcp
[mcp-spec]: https://modelcontextprotocol.io

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup, the
desktop app architecture, and the documentation sources in [`docs/`](./docs).

## License

BSD-3-Clause
