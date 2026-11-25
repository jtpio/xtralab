"""xtralab for JupyterLite: the xtralab extensions and defaults, in the browser."""

try:
    from ._version import __version__
except ImportError:
    import warnings

    warnings.warn("Importing 'xtralite' outside a proper installation.")
    __version__ = "dev"
