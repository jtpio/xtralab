"""The `xtralab` command: JupyterLab with the xtralab configuration folder."""

import os
import sys

import platformdirs


def config_dir() -> str:
    """The Jupyter config folder of xtralab, shared with the desktop app."""
    root = platformdirs.user_config_dir("xtralab", appauthor=False, roaming=True)
    return os.path.join(root, "jupyter", "config")


def main() -> None:
    """Run `jupyter lab` with xtralab's config folder, or the `open` subcommand."""
    # The default of LabApp.user_settings_dir is read at import time, so the
    # environment must be set before jupyterlab is imported.
    os.environ.setdefault("JUPYTER_CONFIG_DIR", config_dir())
    command, args = sys.argv[1:2], sys.argv[2:]
    if command == ["open"]:
        from .servers import open_main

        sys.exit(open_main(args))
    # `stop <port>` stays the Jupyter Server command; a folder names the
    # server to stop instead.
    if command == ["stop"] and args and not args[0].isdigit():
        from .servers import stop_main

        sys.exit(stop_main(args))
    from jupyterlab.labapp import main as lab_main

    lab_main()
