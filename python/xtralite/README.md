# xtralite

[xtralab](https://github.com/jtpio/xtralab) for
[JupyterLite](https://jupyterlite.readthedocs.io): the xtralab extensions and
defaults in the browser, with no server.

xtralite installs the xtralab extensions, the
[pi coding agent](https://github.com/jupyter-ai-contrib/jupyter-ai-pi-lite) for
the JupyterLite terminal, and the chat of
[Jupyter AI Lite](https://github.com/jupyterlite/ai). The launcher, the omnibox
and the ask-agent prompt send a prompt to pi in a terminal, or to Pi or
Jupyternaut in a chat.

```bash
pip install xtralite
jupyter lite build
```

`jupyter lite build` applies the xtralab defaults and disables the
extensions that need a server (git, language servers, search and replace).

See the [documentation](https://jtpio.github.io/xtralab/jupyterlite/).
