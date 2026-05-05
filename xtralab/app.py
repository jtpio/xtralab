"""Desktop launcher for xtralab.

Spawns ``jupyter lab`` in the background, opens it in a dedicated Chrome window
via ``--app`` mode with an isolated user-data directory, and shuts the server
down when the window closes. Requires Chrome or Chromium to be installed.

macOS only for now; other platforms will be added later.
"""

from __future__ import annotations

import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from shutil import which


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _find_chrome() -> str | None:
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
        resolved = which(candidate)
        if resolved:
            return resolved
    return None


def _profile_dir() -> Path:
    profile = (
        Path.home() / "Library" / "Application Support" / "Xtralab" / "chrome-profile"
    )
    profile.mkdir(parents=True, exist_ok=True)
    return profile


def _wait_ready(url: str, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if 200 <= response.status < 400:
                    return True
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.2)
    return False


def _shutdown_server(base: str, token: str) -> None:
    request = urllib.request.Request(
        f"{base}/api/shutdown?_xsrf={token}",
        method="POST",
        headers={"Authorization": f"token {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=2):
            pass
    except Exception:
        pass


def _terminate(proc: subprocess.Popen | None, timeout: float = 3.0) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


def main() -> int:
    if sys.platform != "darwin":
        print(
            f"error: xtralab desktop launcher currently supports macOS only "
            f"(detected platform: {sys.platform!r})",
            file=sys.stderr,
        )
        return 1

    chrome = _find_chrome()
    if chrome is None:
        print("error: Chrome or Chromium not found", file=sys.stderr)
        return 1

    # First Ctrl-C raises KeyboardInterrupt for graceful shutdown; a second one
    # falls through to the default handler and kills the launcher hard.
    def _on_interrupt(signum: int, frame: object) -> None:
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, _on_interrupt)

    port = _free_port()
    token = secrets.token_hex(19)
    base = f"http://127.0.0.1:{port}"

    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "jupyter",
            "lab",
            "--no-browser",
            "--ServerApp.ip=127.0.0.1",
            f"--ServerApp.port={port}",
            f"--IdentityProvider.token={token}",
            "--ServerApp.open_browser=False",
            "--ServerApp.allow_remote_access=False",
        ],
        start_new_session=True,
    )

    chrome_proc: subprocess.Popen | None = None

    try:
        if not _wait_ready(f"{base}/api"):
            print("error: jupyter server failed to start", file=sys.stderr)
            return 1

        chrome_proc = subprocess.Popen(
            [
                chrome,
                f"--app={base}/lab?token={token}",
                f"--user-data-dir={_profile_dir()}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        chrome_proc.wait()

        _shutdown_server(base, token)
    except KeyboardInterrupt:
        print("\nshutting down...", file=sys.stderr)
    finally:
        _terminate(chrome_proc)
        _terminate(server)

    return 0


if __name__ == "__main__":
    sys.exit(main())
