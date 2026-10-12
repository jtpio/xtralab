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
    if sys.argv[1:2] == ["open"]:
        from .open import main as open_main

        sys.exit(open_main(sys.argv[2:]))
    from jupyterlab.labapp import main as lab_main

    lab_main()
