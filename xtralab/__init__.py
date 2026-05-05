try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings
    warnings.warn("Importing 'xtralab' outside a proper installation.")
    __version__ = "dev"


def _jupyter_labextension_paths():
    return [{
        "src": "labextension",
        "dest": "xtralab"
    }]


def _jupyter_server_extension_points():
    return [{"module": "xtralab.server"}]


def _load_jupyter_server_extension(server_app):
    from .server import _load_jupyter_server_extension as _load
    _load(server_app)
