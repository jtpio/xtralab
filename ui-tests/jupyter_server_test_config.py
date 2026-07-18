"""Server configuration for the Galata screenshot suite."""

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)  # noqa: F821

# A non-default port so the suite never collides with a dev server on 8888.
c.ServerApp.port = 8899  # noqa: F821
