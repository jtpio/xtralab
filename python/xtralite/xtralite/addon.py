"""A JupyterLite addon that adds the xtralite application to a site.

The application is the ``xtralite`` folder of the site, next to the JupyterLab
application (``lab``), and it uses the same JavaScript files. Its configuration
has the defaults that xtralab has for JupyterLab (read from the ``xtralab``
package), then the changes of xtralite for the browser (``jupyter-lite.json``
next to this module). Only this application loads the xtralab and xtralite
extensions, so the other applications of the site do not get them.
"""

from __future__ import annotations

import json
import tarfile
from pathlib import Path
from typing import Any

from jupyterlite_core.addons.federated_extensions import FederatedExtensionAddon
from jupyterlite_core.constants import (
    ALL_FEDERATED_JSON,
    DISABLED_EXTENSIONS,
    FEDERATED_EXTENSIONS,
    INDEX_HTML,
    JSON_FMT,
    JUPYTER_CONFIG_DATA,
    JUPYTERLITE_IPYNB,
    JUPYTERLITE_JSON,
    OVERRIDES_JSON,
    PACKAGE_JSON,
    SETTINGS_OVERRIDES,
    UTF8,
)
from xtralab import CONFIG_DIR as XTRALAB_CONFIG_DIR
from xtralab import LABEXTENSIONS_DIR as XTRALAB_LABEXTENSIONS_DIR

HERE = Path(__file__).parent

#: The folder of the application in the site.
APP = "xtralite"

#: The application whose files xtralite uses.
LAB = "lab"

#: The extensions that only the xtralite application loads.
EXTENSIONS = [XTRALAB_LABEXTENSIONS_DIR / "xtralab", HERE / "labextensions" / "xtralite"]

#: The extensions that come with xtralab and need a server. They are in the
#: environment, so JupyterLite adds them to all the applications of the site.
SERVER_EXTENSIONS = [
    "@jupyter-ai/router",
    "@jupyter-lsp/completion-manager",
    "@jupyter-lsp/fileeditor-adapter",
    "@jupyter-lsp/jupyterlab-lsp",
    "@jupyter-lsp/notebook-adapter",
    "@jupyter-lsp/theme-material",
    "@jupyter-lsp/theme-vscode",
    "@jupyter/docprovider-extension",
    "@jupyterlab/git",
    "jupyterlab-commands-toolkit",
    "jupyterlab-search-replace",
    "nbdime-jupyterlab",
]


def xtralab_config() -> dict[str, Any]:
    """The page config and setting overrides of xtralab, as lite config."""
    config = json.loads((XTRALAB_CONFIG_DIR / "page_config.json").read_text(**UTF8))
    # JupyterLab maps the disabled plugins to booleans; JupyterLite lists them.
    disabled = config.get(DISABLED_EXTENSIONS, {})
    config[DISABLED_EXTENSIONS] = [name for name, off in disabled.items() if off]
    overrides = (XTRALAB_CONFIG_DIR / "overrides.json").read_text(**UTF8)
    config[SETTINGS_OVERRIDES] = json.loads(overrides)
    return config


class XtraliteAddon(FederatedExtensionAddon):
    """Add the xtralite application to the site."""

    __all__ = ["post_init", "pre_build", "post_build"]

    @property
    def app_dir(self) -> Path:
        return self.manager.output_dir / APP

    @property
    def has_lab(self) -> bool:
        """Whether the site has the application that xtralite takes its files from."""
        return not self.manager.apps or LAB in self.manager.apps

    def post_init(self, manager):
        """Make the application folder, so that JupyterLite accepts the site config for it."""
        if not self.has_lab:
            self.log.warning(f"[lite] [xtralite] no '{APP}' app: it needs the '{LAB}' app")
            return
        yield self.task(
            name="app",
            doc=f"make the {APP} application from the {LAB} application",
            file_dep=[manager.app_archive],
            targets=[self.app_dir / INDEX_HTML, self.app_dir / JUPYTERLITE_IPYNB],
            actions=[self.make_app],
        )

    def pre_build(self, manager):
        """Remove the extensions of an earlier build, so that the site does not list them."""
        yield self.task(
            name="clean",
            actions=[(self.delete_one, [self.output_extensions / p.name for p in EXTENSIONS])],
        )

    def post_build(self, manager):
        """Add the extensions and the configuration, after the site has its own extensions."""
        actions = [self.disable_server_extensions]
        if self.has_lab:
            actions.append(self.add_extensions)
        yield self.task(
            name="extensions",
            doc=f"add the extensions and the configuration of the {APP} application",
            task_dep=[f"{manager.task_prefix}post_build:federated_extensions:patch"],
            actions=actions,
        )

    def lab_file(self, name: str) -> str:
        """A file of the lab application from the archive, without the site config."""
        with tarfile.open(self.manager.app_archive) as archive:
            return archive.extractfile(f"package/{LAB}/{name}").read().decode("utf-8")

    def make_app(self) -> None:
        self.app_dir.mkdir(parents=True, exist_ok=True)
        index = self.lab_file(INDEX_HTML).replace("JupyterLite", APP)
        (self.app_dir / INDEX_HTML).write_text(index, **UTF8)
        (self.app_dir / JUPYTERLITE_IPYNB).write_text(self.lab_file(JUPYTERLITE_IPYNB), **UTF8)
        self.maybe_timestamp(self.app_dir)

    def app_config(self) -> dict[str, Any]:
        """The configuration of lab, xtralab and xtralite, then of the site for xtralite."""
        config = json.loads(self.lab_file(JUPYTERLITE_JSON))
        xtralite = json.loads((HERE / JUPYTERLITE_JSON).read_text(**UTF8))
        layers = [xtralab_config(), xtralite[JUPYTER_CONFIG_DATA]]
        site_dir = self.manager.lite_dir / APP
        if (site_dir / JUPYTERLITE_JSON).exists():
            site = json.loads((site_dir / JUPYTERLITE_JSON).read_text(**UTF8))
            layers.append(site.get(JUPYTER_CONFIG_DATA, {}))
        if (site_dir / OVERRIDES_JSON).exists():
            overrides = json.loads((site_dir / OVERRIDES_JSON).read_text(**UTF8))
            layers.append({SETTINGS_OVERRIDES: overrides})
        for layer in layers:
            config[JUPYTER_CONFIG_DATA] = self.merge_jupyter_config_data(
                config[JUPYTER_CONFIG_DATA], layer
            )
        return config

    def add_extensions(self) -> None:
        for extension in EXTENSIONS:
            self.copy_one(extension, self.output_extensions / extension.name)

        # The settings service reads all the schemas from one folder.
        schemas = self.manager.output_dir / "build" / "schemas"
        self.copy_one(schemas / "all.json", self.app_dir / "schemas" / "all.json")
        self.ensure_federated_settings(
            self.manager,
            self.env_extensions(self.output_extensions),
            self.app_dir / "schemas" / ALL_FEDERATED_JSON,
        )

        # Each build writes the full configuration, so it does not depend on earlier builds.
        config = self.app_config()
        extensions = config[JUPYTER_CONFIG_DATA].setdefault(FEDERATED_EXTENSIONS, [])
        for extension in EXTENSIONS:
            package = json.loads((extension / PACKAGE_JSON).read_text(**UTF8))
            entry = {"name": package["name"], **package["jupyterlab"]["_build"]}
            if DISABLED_EXTENSIONS in package["jupyterlab"]:
                entry[DISABLED_EXTENSIONS] = package["jupyterlab"][DISABLED_EXTENSIONS]
            extensions.append(entry)
        self.write_json(self.app_dir / JUPYTERLITE_JSON, config)

    def disable_server_extensions(self) -> None:
        jupyterlite_json = self.manager.output_dir / JUPYTERLITE_JSON
        config = json.loads(jupyterlite_json.read_text(**UTF8))
        data = config[JUPYTER_CONFIG_DATA]
        disabled = data.get(DISABLED_EXTENSIONS, [])
        data[DISABLED_EXTENSIONS] = [
            *disabled,
            *(name for name in SERVER_EXTENSIONS if name not in disabled),
        ]
        self.write_json(jupyterlite_json, config)

    def write_json(self, path: Path, config: dict[str, Any]) -> None:
        path.write_text(json.dumps(config, **JSON_FMT), **UTF8)
        self.maybe_timestamp(path)
