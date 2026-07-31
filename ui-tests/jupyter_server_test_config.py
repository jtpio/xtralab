"""Server configuration for the Galata screenshot suite."""

import os

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)  # noqa: F821

# A non-default port so the suite never collides with a dev server on 8888.
c.ServerApp.port = 8899  # noqa: F821

# Run the server from inside the seeded project: jupyterlab-quickopen hides
# any file whose path relative to the process CWD contains a hidden ("dot")
# component, and new terminals (the hero's Claude Code session) spawn in the
# process CWD as well.
os.chdir(os.environ["JUPYTERLAB_GALATA_ROOT_DIR"])

# Terminals inherit the server environment. When the suite itself is launched
# from inside an agent session, that environment carries the agent's session
# markers, and the hero's Claude Code session would render nested-session
# warnings instead of its normal welcome screen.
for key in list(os.environ):
    if key.startswith(("CLAUDE", "ANTHROPIC")):
        del os.environ[key]
