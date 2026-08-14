"""Reusable JupyterLab server supervisor for xtralab desktop shells."""

from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass
from typing import IO, Any


@dataclass(frozen=True)
class ServerInfo:
    """Connection details for a supervised Jupyter server."""

    url: str
    base_url: str
    token: str

    def to_json_dict(self) -> dict[str, str]:
        return {
            "url": self.url,
            "baseUrl": self.base_url,
            "token": self.token,
        }

    def to_json_line(self) -> str:
        return json.dumps(self.to_json_dict(), separators=(",", ":"))


def free_port() -> int:
    """Return an available loopback TCP port."""

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(
    url: str,
    timeout: float = 30.0,
    process: subprocess.Popen[Any] | None = None,
) -> bool:
    """Wait until an HTTP endpoint responds with a non-error status."""

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if 200 <= response.status < 400:
                    return True
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.2)
    return False


def shutdown_server(base_url: str, token: str) -> None:
    """Ask Jupyter Server to shut down through its REST API."""

    request = urllib.request.Request(
        f"{base_url}/api/shutdown?token={token}",
        method="POST",
        headers={
            "Authorization": f"token {token}",
            "X-XSRFToken": token,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=2):
            pass
    except Exception:
        pass


def popen_session_kwargs() -> dict[str, Any]:
    """Return platform-specific kwargs for starting a child process group."""

    if os.name == "posix":
        return {"start_new_session": True}
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    return {}


def terminate_process_tree(
    process: subprocess.Popen[Any] | None,
    timeout: float = 3.0,
) -> None:
    """Terminate a child process and its process group when possible."""

    if process is None or process.poll() is not None:
        return

    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except PermissionError:
            process.terminate()
    else:
        process.terminate()

    try:
        process.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass

    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        except PermissionError:
            process.kill()
    else:
        process.kill()

    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


class JupyterLabSupervisor:
    """Own the lifecycle of a local JupyterLab child process."""

    def __init__(
        self,
        *,
        python: str = sys.executable,
        cwd: str | os.PathLike[str] | None = None,
        env: dict[str, str] | None = None,
        ready_timeout: float = 30.0,
        extra_args: Sequence[str] = (),
        workspace: str | None = None,
    ) -> None:
        self.python = python
        self.cwd = cwd
        self.env = env
        self.ready_timeout = ready_timeout
        self.extra_args: tuple[str, ...] = tuple(extra_args)
        self.port = free_port()
        self.mcp_port = free_port()
        self.token = secrets.token_hex(19)
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.mcp_url = f"http://127.0.0.1:{self.mcp_port}/mcp"
        # Plain ``/lab`` shares the ``default`` workspace, so one folder would
        # restore another's tabs; jupyterlab_server routes only ``[A-Za-z0-9_-]``.
        app_path = "/lab"
        if workspace:
            app_path = f"/lab/workspaces/{urllib.parse.quote(workspace, safe='')}"
        self.info = ServerInfo(
            url=f"{self.base_url}{app_path}?token={self.token}",
            base_url=self.base_url,
            token=self.token,
        )
        self.process: subprocess.Popen[Any] | None = None

    @property
    def command(self) -> list[str]:
        command = [
            self.python,
            "-m",
            "jupyter",
            "lab",
            "--no-browser",
            "--ServerApp.ip=127.0.0.1",
            f"--ServerApp.port={self.port}",
            f"--IdentityProvider.token={self.token}",
            "--ServerApp.open_browser=False",
            "--ServerApp.allow_remote_access=False",
            f"--MCPExtensionApp.mcp_port={self.mcp_port}",
        ]
        if self.cwd is not None:
            command.append(f"--ServerApp.root_dir={os.fspath(self.cwd)}")
        command.extend(self.extra_args)
        return command

    def start(
        self,
        *,
        stdout: int | IO[Any] | None = None,
        stderr: int | IO[Any] | None = None,
    ) -> ServerInfo:
        if self.process is not None:
            raise RuntimeError("JupyterLab supervisor has already been started")

        # Terminals and their agents inherit this, so jupyter-server-mcp-proxy
        # connects to this server's port instead of runtime-file discovery.
        child_env = dict(os.environ if self.env is None else self.env)
        child_env["JUPYTER_SERVER_MCP_URL"] = self.mcp_url

        try:
            self.process = subprocess.Popen(
                self.command,
                cwd=self.cwd,
                env=child_env,
                # rg (jupyterlab-search-replace) blocks searching the readable
                # stdin pipe the desktop shell hands us; rg ignores character devices.
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                **popen_session_kwargs(),
            )
        except OSError as error:
            raise RuntimeError(f"failed to start jupyter server: {error}") from error

        if not wait_ready(
            f"{self.base_url}/api",
            timeout=self.ready_timeout,
            process=self.process,
        ):
            terminate_process_tree(self.process)
            self.process = None
            raise RuntimeError("jupyter server failed to start")

        return self.info

    def shutdown(self) -> None:
        if self.process is None:
            return

        if self.process.poll() is None:
            shutdown_server(self.base_url, self.token)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                terminate_process_tree(self.process)

        self.process = None
