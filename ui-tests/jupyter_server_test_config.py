"""Server configuration for the Galata screenshot suite."""

import json
import os
from pathlib import Path

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)  # noqa: F821

# A non-default port so the suite never collides with a dev server on 8888.
c.ServerApp.port = 8899  # noqa: F821

# quickopen hides files whose path relative to the process CWD has a hidden
# ("dot") component, and new terminals spawn in that CWD as well.
os.chdir(os.environ["JUPYTERLAB_GALATA_ROOT_DIR"])

# Terminals inherit the server environment: leaked agent-session vars make the
# captured Claude Code session render nested-session warnings.
for key in list(os.environ):
    if key.startswith(("CLAUDE", "ANTHROPIC")):
        del os.environ[key]

# Galata's fonts plugin swaps in DejaVu fonts and turns off font smoothing, so
# regression screenshots match across platforms. The docs show the real UI.
labconfig = Path(os.environ["JUPYTER_CONFIG_DIR"], "labconfig")
labconfig.mkdir(parents=True, exist_ok=True)
(labconfig / "page_config.json").write_text(
    json.dumps({"disabledExtensions": {"@jupyterlab/galata-extension:fonts": True}})
)
