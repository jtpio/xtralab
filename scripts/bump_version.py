#!/usr/bin/env python3
"""Bump the version of every package in the monorepo at once.

Updates the root ``package.json``, the npm packages under ``packages/`` and
their dependencies on each other, the ``_version.py`` file of the Python
packages under ``python/``, and the exact pins between them (``xtralite``
pins ``xtralab``), so that all the packages are released together.

Usage::

    python scripts/bump_version.py <major|minor|release|next|patch|VERSION>
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import click
from packaging.version import parse

ROOT = Path(__file__).resolve().parent.parent
VERSION_SPEC = ["major", "minor", "release", "next", "patch"]


def increment_version(current: str, spec: str) -> str:
    """The version after ``current`` for a named spec, in Python format."""
    curr = parse(current)
    if spec == "major":
        return f"{curr.major + 1}.0.0a0"
    if spec == "minor":
        return f"{curr.major}.{curr.minor + 1}.0a0"
    if spec == "release":
        suffix = ""
        if curr.pre:
            following = {"a": "b", "b": "rc", "rc": None}[curr.pre[0]]
            suffix = f"{following}0" if following else ""
        return f"{curr.major}.{curr.minor}.{curr.micro}{suffix}"
    if spec == "next":
        if curr.pre:
            p, x = curr.pre
            return f"{curr.major}.{curr.minor}.{curr.micro}{p}{x + 1}"
        return f"{curr.major}.{curr.minor}.{curr.micro + 1}"
    if spec == "patch":
        micro = curr.micro if curr.pre else curr.micro + 1
        return f"{curr.major}.{curr.minor}.{micro}"
    raise ValueError(f"Unknown version spec: {spec}")


def to_js_version(version: str) -> str:
    """Convert a Python version to the matching npm version."""
    v = parse(version)
    js_version = f"{v.major}.{v.minor}.{v.micro}"
    if v.pre:
        p, x = v.pre
        p = {"a": "alpha", "b": "beta"}.get(p, p)
        js_version += f"-{p}.{x}"
    return js_version


def current_version() -> str:
    """The current version, from the root ``package.json``, in Python format."""
    js_version = json.loads((ROOT / "package.json").read_text())["version"]
    return str(parse(js_version))


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=4) + "\n")


def bump_npm(js_version: str) -> None:
    pkg_files = sorted(ROOT.glob("packages/*/package.json"))
    local = {json.loads(p.read_text())["name"] for p in pkg_files}
    for pkg_file in [ROOT / "package.json", *pkg_files]:
        data = json.loads(pkg_file.read_text())
        data["version"] = js_version
        for field in ("dependencies", "devDependencies", "peerDependencies"):
            for name in data.get(field, {}):
                if name in local:
                    data[field][name] = f"^{js_version}"
        write_json(pkg_file, data)


def bump_python(version: str) -> None:
    for version_file in sorted(ROOT.glob("python/*/*/_version.py")):
        version_file.write_text(f'__version__ = "{version}"\n')

    local = set()
    pyprojects = sorted(ROOT.glob("python/*/pyproject.toml"))
    for pyproject in pyprojects:
        match = re.search(r'^name = "([^"]+)"', pyproject.read_text(), re.MULTILINE)
        if match:
            local.add(match.group(1))
    for pyproject in pyprojects:
        text = pyproject.read_text()
        for name in local:
            text = re.sub(rf'"{re.escape(name)}==[^"]+"', f'"{name}=={version}"', text)
        pyproject.write_text(text)


@click.command()
@click.option("--skip-if-dirty", default=False, is_flag=True)
@click.argument("spec", nargs=1)
def bump(skip_if_dirty: bool, spec: str) -> None:
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    if status:
        if skip_if_dirty:
            return
        raise click.ClickException("Must be in a clean git state with no untracked files")

    version = increment_version(current_version(), spec) if spec in VERSION_SPEC else spec
    version = str(parse(version))
    bump_npm(to_js_version(version))
    bump_python(version)
    click.echo(f"Bumped all the packages to {version}")


if __name__ == "__main__":
    bump()
