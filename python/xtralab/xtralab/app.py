"""The xtralab application: JupyterLab with the extension and defaults of xtralab."""

from __future__ import annotations

import json
import os

from jupyter_core.paths import jupyter_path
from jupyter_server.serverapp import ServerApp
from jupyterlab.labapp import LabApp
from traitlets import default
from traitlets.config import Config

from . import CONFIG_DIR, LABEXTENSIONS_DIR, __version__
from .server import advertise_terminal, disable_checkpoints, handlers


class XtralabServerApp(ServerApp):
    """The Jupyter server of xtralab, with the server defaults of xtralab."""

    def load_config_file(self, *args, **kwargs) -> None:
        # Before the config files: the files and the command line win.
        defaults = (CONFIG_DIR / "server_config.json").read_text("utf-8")
        self.update_config(Config(json.loads(defaults)))
        super().load_config_file(*args, **kwargs)


class XtralabApp(LabApp):
    """An application apart from JupyterLab, built on the JupyterLab frontend.

    The extension, the settings and the server defaults of xtralab are in this
    package, so the JupyterLab of the same environment does not get them.
    """

    name = "xtralab"
    version = __version__
    description = "xtralab - JupyterLab for coding agents."
    serverapp_class = XtralabServerApp

    @default("config_file_name")
    def _default_config_file_name(self) -> str:
        # The settings folder of xtralab can have this file from earlier versions.
        return "jupyter_lab_config"

    @default("app_settings_dir")
    def _default_app_settings_dir(self) -> str:
        return str(CONFIG_DIR)

    @default("labextensions_path")
    def _default_labextensions_path(self) -> list[str]:
        return [str(LABEXTENSIONS_DIR), *jupyter_path("labextensions")]

    @classmethod
    def make_serverapp(cls, **kwargs):
        """Create the server without the JupyterLab application.

        The JupyterLab frontend only routes the `/lab` URL, so xtralab uses
        that URL and the two applications cannot run in the same server.
        """
        kwargs["jpserver_extensions"]["jupyterlab"] = False
        return super().make_serverapp(**kwargs)

    def initialize_handlers(self) -> None:
        serverapp = self.serverapp
        self.handlers.extend(handlers)
        # The labextension makes requests to the server only with this option,
        # which JupyterLite does not set.
        page_config = serverapp.web_app.settings.setdefault("page_config_data", {})
        page_config["xtralabServer"] = True
        disable_checkpoints(serverapp)
        advertise_terminal(serverapp)
        # JupyterLab shows the application name in the browser tab title.
        root = os.path.normpath(serverapp.root_dir)
        self.app_name = os.path.basename(root) or root
        super().initialize_handlers()


main = XtralabApp.launch_instance
