"""Desktop launchers for xtralab.

Spawns ``jupyter lab`` in the background, opens it in a dedicated Chrome window
via ``--app`` mode with an isolated user-data directory, and shuts the server
down when the window closes. Requires Chrome or Chromium to be installed.

macOS only for now; other platforms will be added later.
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import threading
from pathlib import Path
from shutil import which

from .supervisor import JupyterLabSupervisor, ServerInfo, terminate_process_tree


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
        Path.home() / "Library" / "Application Support" / "xtralab" / "chrome-profile"
    )
    profile.mkdir(parents=True, exist_ok=True)
    return profile


def _launch_chrome_app(info: ServerInfo, chrome: str) -> subprocess.Popen:
    return subprocess.Popen(
        [
            chrome,
            f"--app={info.url}",
            f"--user-data-dir={_profile_dir()}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _chrome_main() -> int:
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

    supervisor: JupyterLabSupervisor | None = None
    chrome_proc: subprocess.Popen | None = None

    try:
        supervisor = JupyterLabSupervisor()
        info = supervisor.start()
        chrome_proc = _launch_chrome_app(info, chrome)
        chrome_proc.wait()
    except KeyboardInterrupt:
        print("\nshutting down...", file=sys.stderr)
    except (OSError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        terminate_process_tree(chrome_proc)
        if supervisor is not None:
            supervisor.shutdown()

    return 0


def _monitor_stdin(stop_event: threading.Event) -> None:
    try:
        sys.stdin.buffer.read()
    except Exception:
        return
    stop_event.set()


def _serve_main(args: argparse.Namespace) -> int:
    stop_event = threading.Event()
    interrupted = False

    def _on_signal(signum: int, frame: object) -> None:
        nonlocal interrupted
        interrupted = True
        stop_event.set()

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    cwd: Path | None = None
    if args.cwd is not None:
        cwd = Path(args.cwd).expanduser().resolve()
        if not cwd.is_dir():
            print(f"error: not a directory: {cwd}", file=sys.stderr)
            return 1

    try:
        supervisor = JupyterLabSupervisor(cwd=cwd, ready_timeout=args.timeout)
        info = supervisor.start(stdout=sys.stderr, stderr=sys.stderr)
    except (OSError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    try:
        if not sys.stdin.isatty():
            threading.Thread(
                target=_monitor_stdin,
                args=(stop_event,),
                daemon=True,
            ).start()

        if args.json:
            print(info.to_json_line(), flush=True)
        else:
            print(info.url, flush=True)

        while not stop_event.wait(0.2):
            if supervisor.process is not None and supervisor.process.poll() is not None:
                return supervisor.process.returncode or 1
    finally:
        if interrupted:
            print("\nshutting down...", file=sys.stderr)
        supervisor.shutdown()

    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="xtralab")
    subparsers = parser.add_subparsers(dest="command")

    serve = subparsers.add_parser(
        "serve",
        help="start a supervised local JupyterLab server",
    )
    serve.add_argument(
        "--json",
        action="store_true",
        help="print a single ready JSON line for desktop shells",
    )
    serve.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="seconds to wait for the Jupyter server to become ready",
    )
    serve.add_argument(
        "--cwd",
        help="directory to use as the JupyterLab server root",
    )
    serve.set_defaults(func=_serve_main)
    return parser


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        return _chrome_main()

    parser = _build_parser()
    args = parser.parse_args(argv)
    if hasattr(args, "func"):
        return args.func(args)

    return _chrome_main()


if __name__ == "__main__":
    sys.exit(main())
