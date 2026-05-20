#!/usr/bin/env python3
"""Sync the desktop sub-project version to the root version.

Run by jupyter-releaser as an ``after-bump-version`` hook, after
``hatch version`` has updated the root ``package.json``. Propagates the new
version to ``desktop/package.json``, ``desktop/pyproject.toml``, and
``desktop/uv.lock`` so the "Publish X.Y.Z" commit picks them up.

``desktop/pnpm-lock.yaml`` does not record the workspace's own version
(only its dependencies), so no JS lockfile update is needed.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP = REPO_ROOT / "desktop"


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


def main() -> None:
    version = json.loads((REPO_ROOT / "package.json").read_text())["version"]
    print(f"Syncing desktop sub-project to {version}")

    pkg_path = DESKTOP / "package.json"
    pkg = json.loads(pkg_path.read_text())
    pkg["version"] = version
    write_json(pkg_path, pkg)

    pyproject = DESKTOP / "pyproject.toml"
    text = pyproject.read_text()
    new_text, count = re.subn(
        r'^version = "[^"]+"',
        f'version = "{version}"',
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise SystemExit(f"Failed to find version line in {pyproject}")
    pyproject.write_text(new_text)

    if shutil.which("uv") is None:
        subprocess.run([sys.executable, "-m", "pip", "install", "uv"], check=True)
    subprocess.run(["uv", "lock"], cwd=DESKTOP, check=True)


if __name__ == "__main__":
    main()
