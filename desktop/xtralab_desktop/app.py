"""Command-line helpers for xtralab desktop shells."""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
from pathlib import Path

from .supervisor import JupyterLabSupervisor


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

    extra_args: list[str] = []
    if args.no_collab_persistence:
        # xtralab.ystore explains why persisted history corrupts docs edited on
        # disk; jupyter_server_config.d never reaches an ExtensionApp, hence CLI.
        extra_args.append("--YDocExtension.ystore_class=xtralab.ystore.NoYStore")
        # Without a ystore a cross-restart reconnect silently diverges; an empty
        # session store makes it fail closed with the "Session expired" prompt.
        extra_args.append(f"--YDocExtension.session_store_path={os.devnull}")
    elif args.collab_ystore_db is not None:
        db_path = Path(args.collab_ystore_db).expanduser().resolve()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        # SQLiteYStore ships with jupyter-server-ydoc.
        extra_args.append(f"--SQLiteYStore.db_path={db_path}")

    try:
        supervisor = JupyterLabSupervisor(
            cwd=cwd,
            ready_timeout=args.timeout,
            extra_args=extra_args,
            workspace=args.workspace,
        )
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
    serve.add_argument(
        "--collab-ystore-db",
        help=(
            "path to the jupyter-server-ydoc SQLite database "
            "(default: '.jupyter_ystore.db' under --cwd); ignored when "
            "--no-collab-persistence is given"
        ),
    )
    serve.add_argument(
        "--no-collab-persistence",
        action="store_true",
        help=(
            "keep real-time collaboration but persist nothing between server "
            "runs: documents rebuild from disk and clients from an older run "
            "must reload"
        ),
    )
    serve.add_argument(
        "--workspace",
        help=(
            "JupyterLab workspace name to load as '/lab/workspaces/<name>' so "
            "the folder keeps its own tabs and layout (default: the shared "
            "'/lab' workspace)"
        ),
    )
    serve.set_defaults(func=_serve_main)
    return parser


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = _build_parser()
    args = parser.parse_args(argv)
    if hasattr(args, "func"):
        return args.func(args)

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
