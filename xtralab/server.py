"""Server-side helpers for the xtralab labextension.

Currently exposes a single endpoint, ``/xtralab/agents/availability``, which
the launcher polls at activation to figure out which configured agent
commands are present on ``$PATH``. The endpoint accepts a list of command
strings (via JSON body or repeated ``command`` query parameters) and replies
with the resolved binary path for each, or ``null`` when ``shutil.which``
returns nothing.

The endpoint is intentionally minimal — a thin ``which`` proxy. The frontend
owns the agent list (defaults + user settings), so the server has no opinion
about which commands matter; it only answers "is this binary on PATH".
"""

from __future__ import annotations

import json
from shutil import which

from jupyter_server.base.handlers import APIHandler
from jupyter_server.serverapp import ServerApp
from jupyter_server.utils import url_path_join
from tornado.web import authenticated


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


def _setup_handlers(server_app: ServerApp) -> None:
    base_url = server_app.web_app.settings["base_url"]
    route = url_path_join(base_url, "xtralab", "agents", "availability")
    server_app.web_app.add_handlers(".*$", [(route, AgentAvailabilityHandler)])


def _load_jupyter_server_extension(server_app: ServerApp) -> None:
    _setup_handlers(server_app)
    server_app.log.info("Registered xtralab server extension")
