"""The `open` and `stop` subcommands: start or stop the server of a folder."""

import os
import subprocess
import sys
import tempfile
import time
import urllib.request

from jupyter_server.serverapp import list_running_servers, shutdown_server

START_TIMEOUT = 120
PROBE_TIMEOUT = 2


def jupyter_servers() -> list[dict]:
    """The info of every running Jupyter server."""
    # Other apps (the MCP server) write jpserver-*.json files too; only
    # Jupyter Server writes base_url.
    return [info for info in list_running_servers() if "base_url" in info]


def running_server(folder: str, pid: int | None = None) -> dict | None:
    """The info of the Jupyter server that serves `folder`, if one runs."""
    for info in jupyter_servers():
        if os.path.realpath(info["root_dir"]) != folder:
            continue
        if pid is None or info["pid"] == pid:
            return info
    return None


def is_xtralab(info: dict) -> bool:
    """True when the server answers on the xtralab API, so it runs the extension."""
    request = urllib.request.Request(
        info["url"] + "xtralab/agents/availability",
        headers={"Authorization": f"token {info.get('token', '')}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT) as response:
            return response.status == 200
    except OSError:
        return False


def xtralab_servers() -> list[dict]:
    """The info of every running server that has the xtralab extension."""
    return [info for info in jupyter_servers() if is_xtralab(info)]


def lab_url(info: dict) -> str:
    url = info["url"] + "lab"
    if info.get("token"):
        url += "?token=" + info["token"]
    return url


def stop_command(info: dict) -> str:
    # uv sets UV for the tools it runs, so the command matches the install.
    command = "uvx xtralab" if os.environ.get("UV") else "xtralab"
    return f"{command} stop {info['port']}"


def report(title: str, info: dict, log: str | None = None) -> None:
    print(title)
    print(f"  URL:     {lab_url(info)}")
    print(f"  Folder:  {info['root_dir']}")
    if log:
        print(f"  Log:     {log}")
    print(f"  Stop:    {stop_command(info)}")


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


def folder_argument(argv: list[str], usage: str) -> str | None:
    """The resolved folder named by `argv`, or None after a usage or folder error."""
    if len(argv) > 1 or argv[:1] in (["-h"], ["--help"]):
        print(usage, file=sys.stderr)
        return None
    folder = os.path.realpath(argv[0] if argv else os.getcwd())
    if not os.path.isdir(folder):
        print(f"error: not a folder: {folder}", file=sys.stderr)
        return None
    return folder


def open_main(argv: list[str]) -> int:
    folder = folder_argument(argv, "usage: xtralab open [folder]")
    if folder is None:
        return 2

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


def list_main(argv: list[str]) -> int:
    if argv:
        print("usage: xtralab list", file=sys.stderr)
        return 2
    servers = xtralab_servers()
    if not servers:
        print("No xtralab server is running.")
        return 0
    for info in servers:
        print(info["root_dir"])
        print(f"  URL:   {lab_url(info)}")
        print(f"  Stop:  {stop_command(info)}")
    return 0


def stop(info: dict) -> bool:
    if not shutdown_server(info):
        print(f"error: the server on port {info['port']} did not stop", file=sys.stderr)
        return False
    print(f"Stopped the xtralab server on port {info['port']} for {info['root_dir']}.")
    return True


def stop_main(argv: list[str]) -> int:
    if argv == ["--all"]:
        servers = xtralab_servers()
        if not servers:
            print("No xtralab server is running.")
            return 0
        results = [stop(info) for info in servers]
        return 0 if all(results) else 1
    folder = folder_argument(argv, "usage: xtralab stop [folder | port | --all]")
    if folder is None:
        return 2
    info = running_server(folder)
    if info is None:
        print(f"error: no xtralab server runs for {folder}", file=sys.stderr)
        return 1
    return 0 if stop(info) else 1
