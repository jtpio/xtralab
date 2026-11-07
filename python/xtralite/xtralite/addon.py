"""A JupyterLite addon that configures ``jupyter lite build`` for xtralite.

The site gets the defaults that xtralab installs for JupyterLab (read from the
installed ``xtralab`` package), then the changes of xtralite for the browser
(``jupyter-lite.json`` next to this module). The ``jupyter-lite.json`` and
``overrides.json`` of the site folder win over both.
"""

from __future__ import annotations

import json
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path
from typing import Any

from jupyterlite_core.addons.base import BaseAddon
from jupyterlite_core.constants import (
    DISABLED_EXTENSIONS,
    JSON_FMT,
    JUPYTER_CONFIG_DATA,
    JUPYTERLITE_JSON,
    OVERRIDES_JSON,
    SETTINGS_OVERRIDES,
    UTF8,
)

HERE = Path(__file__).parent

PAGE_CONFIG = "labconfig/page_config.d/00-xtralab.json"
SETTINGS = "labconfig/default_setting_overrides.d/00-xtralab.json"


def xtralab_config() -> dict[str, Any]:
    """The page config and setting overrides that xtralab installs, as lite config."""
    try:
        files = distribution("xtralab").files or []
    except PackageNotFoundError:
        return {}
    config: dict[str, Any] = {}
    for file in files:
        path = file.as_posix()
        if path.endswith(PAGE_CONFIG):
            page_config = json.loads(file.read_text(encoding="utf-8"))
            # JupyterLab maps the disabled plugins to booleans; JupyterLite lists them.
            disabled = page_config.pop(DISABLED_EXTENSIONS, {})
            config.update(page_config)
            config[DISABLED_EXTENSIONS] = [name for name, off in disabled.items() if off]
        elif path.endswith(SETTINGS):
            config[SETTINGS_OVERRIDES] = json.loads(file.read_text(encoding="utf-8"))
    return config


def merge_config(base: dict[str, Any], top: dict[str, Any]) -> dict[str, Any]:
    """Merge two ``jupyter-config-data`` objects as JupyterLite does at runtime.

    The disabled extensions are added, the setting overrides merge per plugin,
    and the other values of ``top`` replace those of ``base``.
    """
    merged = dict(base)
    for key, value in top.items():
        if key == DISABLED_EXTENSIONS:
            current = merged.get(key, [])
            merged[key] = current + [name for name in value if name not in current]
        elif key == SETTINGS_OVERRIDES:
            overrides = dict(merged.get(key, {}))
            for plugin, defaults in value.items():
                overrides[plugin] = {**overrides.get(plugin, {}), **defaults}
            merged[key] = overrides
        else:
            merged[key] = value
    return merged


def read_config_data(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(**UTF8)).get(JUPYTER_CONFIG_DATA, {})


class XtraliteAddon(BaseAddon):
    """Add the xtralab defaults and the xtralite configuration to the site."""

    __all__ = ["post_build"]

    def post_build(self, manager):
        jupyterlite_json = manager.output_dir / JUPYTERLITE_JSON
        yield self.task(
            name="patch",
            doc=f"add the xtralab and xtralite configuration to {JUPYTERLITE_JSON}",
            file_dep=[jupyterlite_json],
            actions=[(self.patch_jupyterlite_json, [manager, jupyterlite_json])],
        )

    def patch_jupyterlite_json(self, manager, jupyterlite_json: Path) -> None:
        config = json.loads(jupyterlite_json.read_text(**UTF8))
        data = config.setdefault(JUPYTER_CONFIG_DATA, {})
        # The output already holds the site config, which must stay on top.
        site = read_config_data(manager.lite_dir / JUPYTERLITE_JSON)
        overrides_json = manager.lite_dir / OVERRIDES_JSON
        if overrides_json.exists():
            site_overrides = json.loads(overrides_json.read_text(**UTF8))
            site = merge_config(site, {SETTINGS_OVERRIDES: site_overrides})
        xtralite = read_config_data(HERE / JUPYTERLITE_JSON)
        for layer in (xtralab_config(), xtralite, site):
            data = merge_config(data, layer)
        config[JUPYTER_CONFIG_DATA] = data
        jupyterlite_json.write_text(json.dumps(config, **JSON_FMT), **UTF8)
        self.maybe_timestamp(jupyterlite_json)
