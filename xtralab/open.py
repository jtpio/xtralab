"""`xtralab open [folder]`: start a detached server for a folder and print its URL."""

import os
import subprocess
import sys
import tempfile
import time

from jupyter_server.serverapp import list_running_servers

USAGE = "usage: xtralab open [folder]"
START_TIMEOUT = 120


def running_server(folder: str, pid: int | None = None) -> dict | None:
    """The info of the Jupyter server that serves `folder`, if one runs."""
    for info in list_running_servers():
        # Other apps (the MCP server) write jpserver-*.json files too; only
        # Jupyter Server writes base_url.
        if "base_url" not in info or os.path.realpath(info["root_dir"]) != folder:
            continue
        if pid is None or info["pid"] == pid:
            return info
    return None


def lab_url(info: dict) -> str:
    url = info["url"] + "lab"
    if info.get("token"):
        url += "?token=" + info["token"]
    return url


def report(title: str, info: dict, log: str | None = None) -> None:
    # uv sets UV for the tools it runs, so the stop command matches the install.
    command = "uvx xtralab" if os.environ.get("UV") else "xtralab"
    print(title)
    print(f"  URL:     {lab_url(info)}")
    print(f"  Folder:  {info['root_dir']}")
    if log:
        print(f"  Log:     {log}")
    print(f"  Stop:    {command} stop {info['port']}")


def start(folder: str) -> tuple[subprocess.Popen, str]:
    """Start a server for `folder` in its own session, with its output in a log file."""
    options = {}
    if sys.platform == "win32":
        options["creationflags"] = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        options["start_new_session"] = True
    fd, log = tempfile.mkstemp(prefix="xtralab-", suffix=".log")
    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "xtralab", folder],
            stdin=subprocess.DEVNULL,
            stdout=fd,
            stderr=subprocess.STDOUT,
            **options,
        )
    finally:
        os.close(fd)
    return proc, log


def main(argv: list[str]) -> int:
    if len(argv) > 1 or argv[:1] in (["-h"], ["--help"]):
        print(USAGE, file=sys.stderr)
        return 2
    folder = os.path.realpath(argv[0] if argv else os.getcwd())
    if not os.path.isdir(folder):
        print(f"error: not a folder: {folder}", file=sys.stderr)
        return 1

    info = running_server(folder)
    if info is not None:
        report("xtralab is already running for this folder.", info)
        return 0

    proc, log = start(folder)
    deadline = time.monotonic() + START_TIMEOUT
    while time.monotonic() < deadline:
        info = running_server(folder, proc.pid)
        if info is not None:
            report("xtralab is running.", info, log)
            return 0
        if proc.poll() is not None:
            print(
                f"error: xtralab stopped before it started to serve. Log: {log}",
                file=sys.stderr,
            )
            with open(log, encoding="utf-8", errors="replace") as f:
                print("".join(f.readlines()[-20:]), file=sys.stderr)
            return 1
        time.sleep(0.5)
    print(
        f"error: xtralab did not start in {START_TIMEOUT} seconds. Log: {log}",
        file=sys.stderr,
    )
    return 1
