from pathlib import Path

try:
    from ._version import __version__
except ImportError:
    import warnings
    warnings.warn("Importing 'xtralab' outside a proper installation.")
    __version__ = "dev"

HERE = Path(__file__).parent

#: The defaults of the application: page config, setting overrides, server config.
CONFIG_DIR = HERE / "config"

#: The labextension of xtralab. Only the xtralab applications load it.
LABEXTENSIONS_DIR = HERE / "labextensions"


def _jupyter_server_extension_points():
    from .app import XtralabApp

    return [{"module": "xtralab", "app": XtralabApp}]
