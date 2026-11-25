# xtralite

[xtralab](https://github.com/jtpio/xtralab) for
[JupyterLite](https://jupyterlite.readthedocs.io): the xtralab extensions and
defaults in the browser, with no server.

xtralite adds an application to a JupyterLite site, next to the JupyterLab
application. It installs the xtralab extensions, the
[pi coding agent](https://github.com/jupyter-ai-contrib/jupyter-ai-pi-lite) for
the JupyterLite terminal, and the chat of
[Jupyter AI Lite](https://github.com/jupyterlite/ai). The launcher, the omnibox
and the ask-agent prompt send a prompt to pi in a terminal, or to Pi or
Jupyternaut in a chat.

```bash
pip install xtralite
jupyter lite build
```

`jupyter lite build` adds the `xtralite` application to the site, with the
xtralab defaults. Open `xtralite/index.html` to use it. The `lab` application
of the site does not load the xtralab extension. The extensions that need a
server (git, language servers, search and replace) are off for the site.

See the [documentation](https://jtpio.github.io/xtralab/jupyterlite/).
