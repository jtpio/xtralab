"""Server-side helpers for the xtralab labextension.

``/xtralab/agents/availability`` resolves agent commands through ``$PATH``;
``/xtralab/terminals/agents`` walks each terminal's child processes (psutil)
to report the running agent — including ones the user started by hand.
"""

from __future__ import annotations

import asyncio
import json
import os
from shutil import which

from jupyter_server.base.handlers import APIHandler
from jupyter_server.serverapp import ServerApp
from jupyter_server.utils import url_path_join
from tornado.web import authenticated

from .checkpoints import NullCheckpoints
from .external_agents import (
    list_sessions,
    read_entries,
    split_id,
    terminal_pids,
)

try:
    import psutil
except ImportError:  # pragma: no cover - psutil is a declared dependency
    psutil = None  # type: ignore[assignment]

_INTERPRETERS = frozenset(
    {"node", "nodejs", "python", "python3", "deno", "bun", "ruby", "perl"}
)


class AgentAvailabilityHandler(APIHandler):
    """Resolve a list of command names through ``shutil.which``."""

    def _resolve(self, commands: list[str]) -> dict[str, str | None]:
        seen: dict[str, str | None] = {}
        for command in commands:
            if not isinstance(command, str) or not command:
                continue
            if command in seen:
                continue
            seen[command] = which(command)
        return seen

    @authenticated
    def get(self) -> None:
        commands = self.get_query_arguments("command")
        self.finish(json.dumps(self._resolve(commands)))

    @authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        commands = body.get("commands") or []
        if not isinstance(commands, list):
            self.set_status(400)
            self.finish(json.dumps({"error": "'commands' must be a list of strings"}))
            return
        self.finish(json.dumps(self._resolve(commands)))


def _candidate_names(name: str, cmdline: list[str]) -> set[str]:
    """Command basenames that could identify one process.

    The process name and ``argv[0]``, plus — for interpreter wrappers only —
    the first non-flag argument, so ``vim claude`` never matches an agent.
    """
    cands: set[str] = set()
    name_base = os.path.basename(name) if name else ""
    if name_base:
        cands.add(name_base)
    argv0 = os.path.basename(cmdline[0]) if cmdline else ""
    if argv0:
        cands.add(argv0)
    if (name_base in _INTERPRETERS or argv0 in _INTERPRETERS) and cmdline:
        for token in cmdline[1:]:
            if token.startswith("-"):
                continue
            base = os.path.basename(token)
            if base:
                cands.add(base)
            break
    return cands


def _match_processes(procs: object, commands: set[str]) -> str | None:
    for proc in procs:  # type: ignore[attr-defined]
        try:
            cands = _candidate_names(proc.name(), proc.cmdline())
        except Exception:
            # Process vanished, or we lack permission to inspect it — skip.
            continue
        for command in commands:
            if command in cands:
                return command
    return None


def _running_agent(pty: object, commands: set[str]) -> str | None:
    """The agent command running in one terminal, or ``None`` at the prompt."""
    ptyproc = getattr(pty, "ptyproc", None)
    pid = getattr(ptyproc, "pid", None)
    if pid is None or psutil is None:
        return None
    try:
        shell = psutil.Process(pid)
    except Exception:
        return None
    # Prefer direct children so a busy agent's grandchildren never shadow it;
    # fall back to the whole subtree for indirection like ``npm exec``.
    try:
        match = _match_processes(shell.children(), commands)
        if match:
            return match
        return _match_processes(shell.children(recursive=True), commands)
    except Exception:
        return None


class RunningAgentsHandler(APIHandler):
    """Report which requested command is running in each open terminal."""

    def _detect(self, commands: list[str]) -> dict[str, str | None]:
        result: dict[str, str | None] = {}
        manager = self.settings.get("terminal_manager")
        wanted = {c for c in commands if isinstance(c, str) and c}
        if manager is None or psutil is None or not wanted:
            return result
        # ``terminals`` is a {name: PtyWithClients} map kept by terminado's
        # NamedTermManager (which jupyter_server_terminals subclasses).
        for name, pty in list(getattr(manager, "terminals", {}).items()):
            result[name] = _running_agent(pty, wanted)
        return result

    @authenticated
    def post(self) -> None:
        body = self.get_json_body() or {}
        commands = body.get("commands") or []
        if not isinstance(commands, list):
            self.set_status(400)
            self.finish(json.dumps({"error": "'commands' must be a list of strings"}))
            return
        self.finish(json.dumps(self._detect(commands)))


class ExternalAgentsHandler(APIHandler):
    """List the agent sessions started outside JupyterLab for the server root."""

    @authenticated
    async def get(self) -> None:
        root = self.settings.get("server_root_dir") or os.getcwd()
        exclude = terminal_pids(self.settings.get("terminal_manager"))
        loop = asyncio.get_running_loop()
        # Process and file scans block; keep them off the event loop.
        sessions = await loop.run_in_executor(
            None, list_sessions, os.path.expanduser(root), exclude
        )
        self.finish(json.dumps({"sessions": [s.to_dict() for s in sessions]}))


class ExternalAgentTranscriptHandler(APIHandler):
    """Replay one session's transcript as normalized entries, incrementally."""

    @authenticated
    async def get(self) -> None:
        resolved = split_id(self.get_query_argument("id", ""))
        if resolved is None:
            self.set_status(404)
            self.finish(json.dumps({"error": "Unknown session"}))
            return
        provider, session_id = resolved
        raw_offset = self.get_query_argument("offset", None)
        offset = int(raw_offset) if raw_offset and raw_offset.isdigit() else None
        path = provider.transcript_path(session_id)
        if path is None:
            self.set_status(404)
            self.finish(json.dumps({"error": "No transcript for this session"}))
            return
        loop = asyncio.get_running_loop()
        entries, next_offset, truncated = await loop.run_in_executor(
            None, read_entries, path, provider.parse, offset
        )
        self.finish(
            json.dumps(
                {"entries": entries, "offset": next_offset, "truncated": truncated}
            )
        )


class ExternalAgentPromptHandler(APIHandler):
    """Deliver a prompt to a running external session."""

    @authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        resolved = split_id(str(body.get("id") or ""))
        text = body.get("text")
        if resolved is None or not isinstance(text, str) or not text.strip():
            self.set_status(400)
            self.finish(json.dumps({"error": "'id' and a non-empty 'text' are required"}))
            return
        provider, session_id = resolved
        try:
            await provider.send(session_id, text)
        except Exception as error:
            self.set_status(502)
            self.finish(json.dumps({"error": str(error)}))
            return
        self.finish(json.dumps({"ok": True}))


def _setup_handlers(server_app: ServerApp) -> None:
    base_url = server_app.web_app.settings["base_url"]
    handlers = [
        (
            url_path_join(base_url, "xtralab", "agents", "availability"),
            AgentAvailabilityHandler,
        ),
        (
            url_path_join(base_url, "xtralab", "terminals", "agents"),
            RunningAgentsHandler,
        ),
        (
            url_path_join(base_url, "xtralab", "external-agents"),
            ExternalAgentsHandler,
        ),
        (
            url_path_join(base_url, "xtralab", "external-agents", "transcript"),
            ExternalAgentTranscriptHandler,
        ),
        (
            url_path_join(base_url, "xtralab", "external-agents", "prompt"),
            ExternalAgentPromptHandler,
        ),
    ]
    server_app.web_app.add_handlers(".*$", handlers)


def _disable_checkpoints(server_app: ServerApp) -> None:
    """Replace the contents manager's checkpoints with a no-op manager.

    The contents manager is built before server extensions load, so both the
    class (for rebuilds) and the live instance must be replaced.
    """
    contents_manager = server_app.contents_manager
    if not hasattr(contents_manager, "checkpoints_class"):
        return
    contents_manager.checkpoints_class = NullCheckpoints
    contents_manager.checkpoints = NullCheckpoints(
        **contents_manager.checkpoints_kwargs
    )


def _load_jupyter_server_extension(server_app: ServerApp) -> None:
    _setup_handlers(server_app)
    _disable_checkpoints(server_app)
    server_app.log.info("Registered xtralab server extension")
