"""Coding-agent sessions started outside JupyterLab, for the open folder.

Each provider reads what its CLI leaves on disk — Claude Code's live session
registry and per-project transcripts, Codex rollout files, pi session files —
to list the sessions, replay their conversation as a normalized entry stream,
and, where the agent offers a way in, deliver a prompt to the running process.
"""

from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import socket
from dataclasses import asdict, dataclass
from shutil import which
from typing import Any, Callable, Iterable

try:
    import psutil
except ImportError:  # pragma: no cover - psutil is a declared dependency
    psutil = None  # type: ignore[assignment]

Record = dict[str, Any]

Entry = dict[str, Any]

TAIL_BYTES = 64 * 1024

DEFAULT_ENTRY_LIMIT = 300

RESULT_MAX_CHARS = 1500

TOOL_INPUT_MAX_CHARS = 200

PROMPT_PREVIEW_CHARS = 160

_SYSTEM_REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)


@dataclass
class ExternalSession:
    """One agent session running outside JupyterLab's own terminals."""

    id: str
    agent: str
    cwd: str
    name: str
    status: str = "unknown"
    pid: int | None = None
    sessionId: str | None = None
    title: str | None = None
    lastPrompt: str | None = None
    startedAt: float | None = None
    transcript: bool = False
    send: bool = False
    attach: str | None = None
    subpath: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


INPUT_VALUE_MAX_CHARS = 4000


def _json_safe(value: Any, depth: int = 0) -> Any:
    """`value` with strings clipped and nesting bounded, safe for ``json.dumps``."""
    if isinstance(value, str):
        return _clip(value, INPUT_VALUE_MAX_CHARS)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if depth >= 4:
        return _clip(str(value), INPUT_VALUE_MAX_CHARS)
    if isinstance(value, dict):
        return {str(k): _json_safe(v, depth + 1) for k, v in list(value.items())[:40]}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v, depth + 1) for v in list(value)[:40]]
    return _clip(str(value), INPUT_VALUE_MAX_CHARS)


def _parse_input(value: Any) -> Any:
    """A tool input as structured data when it is JSON text, else as given."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _entry(
    kind: str,
    text: str,
    name: str | None = None,
    ts: Any = None,
    call_id: Any = None,
    tool_input: Any = None,
) -> Entry:
    entry: Entry = {"kind": kind, "text": text}
    if name:
        entry["name"] = name
    if ts:
        entry["ts"] = ts
    if isinstance(call_id, str) and call_id:
        entry["callId"] = call_id
    if tool_input is not None:
        entry["input"] = _json_safe(_parse_input(tool_input))
    return entry


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _preview(text: str) -> str:
    return _clip(" ".join(text.split()), PROMPT_PREVIEW_CHARS)


def _summarize_input(name: str, value: Any) -> str:
    """A one-line description of a tool call's input."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return _clip(value, TOOL_INPUT_MAX_CHARS)
    if isinstance(value, dict):
        for key in ("command", "cmd", "file_path", "path", "pattern", "query", "url"):
            found = value.get(key)
            if isinstance(found, list):
                found = " ".join(str(part) for part in found)
            if isinstance(found, str) and found:
                return _clip(found, TOOL_INPUT_MAX_CHARS)
        try:
            return _clip(json.dumps(value, ensure_ascii=False), TOOL_INPUT_MAX_CHARS)
        except (TypeError, ValueError):
            return ""
    return _clip(str(value), TOOL_INPUT_MAX_CHARS) if value is not None else ""


def _text_blocks(content: Any, kinds: Iterable[str] = ("text", "input_text", "output_text")) -> str:
    """Concatenate the text blocks of a message content value."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    wanted = set(kinds)
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") in wanted:
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def _clean_user_text(text: str) -> str | None:
    """Drop the machine-generated parts of a user turn; ``None`` if nothing is left."""
    text = _SYSTEM_REMINDER.sub("", text).strip()
    if not text or text.startswith("<") or text.startswith("# AGENTS.md instructions"):
        return None
    return text


def _tail_records(path: str, nbytes: int = TAIL_BYTES) -> list[Record]:
    """The complete JSON lines within the last `nbytes` of a JSONL file."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            if size > nbytes:
                handle.seek(size - nbytes)
                handle.readline()
            data = handle.read()
    except OSError:
        return []
    records: list[Record] = []
    for raw in data.splitlines():
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def read_entries(
    path: str,
    parse: Callable[[Record, list[Entry]], None],
    offset: int | None,
    limit: int = DEFAULT_ENTRY_LIMIT,
) -> tuple[list[Entry], int, bool]:
    """Parse the JSONL records of `path` from `offset` into normalized entries.

    Returns the entries, the byte offset to resume from (just after the last
    complete line) and whether older entries were dropped to honour `limit`
    on a first (offset-less) load.
    """
    size = os.path.getsize(path)
    start = 0 if offset is None or offset > size else offset
    with open(path, "rb") as handle:
        handle.seek(start)
        data = handle.read()
    end = data.rfind(b"\n")
    if end < 0:
        return [], start, False
    entries: list[Entry] = []
    for raw in data[:end].split(b"\n"):
        if not raw.strip():
            continue
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        if isinstance(record, dict):
            parse(record, entries)
    truncated = False
    if offset is None and len(entries) > limit:
        entries = entries[-limit:]
        truncated = True
    return entries, start + end + 1, truncated


def _push(entries: list[Entry], entry: Entry) -> None:
    """Append unless it repeats the previous entry (formats that log a turn twice)."""
    if entries and entries[-1]["kind"] == entry["kind"] and entries[-1]["text"] == entry["text"]:
        return
    entries.append(entry)


def _within(root: str, cwd: str) -> str | None:
    """`cwd` relative to `root` (``""`` for root itself), or ``None`` when outside."""
    try:
        real_root = os.path.realpath(root)
        real_cwd = os.path.realpath(cwd)
        common = os.path.commonpath([real_root, real_cwd])
    except ValueError:
        return None
    if common != real_root:
        return None
    relative = os.path.relpath(real_cwd, real_root)
    return "" if relative == "." else relative


def _process(pid: int | None) -> Any:
    if pid is None or psutil is None:
        return None
    try:
        return psutil.Process(pid)
    except Exception:
        return None


def _created(proc: Any) -> float | None:
    try:
        return float(proc.create_time())
    except Exception:
        return None


class Provider:
    """Discovery, transcript parsing and prompt delivery for one agent CLI."""

    agent = ""

    def sessions(self, root: str, exclude_pids: set[int]) -> list[ExternalSession]:
        return []

    def transcript_path(self, session_id: str) -> str | None:
        return None

    def parse(self, record: Record, entries: list[Entry]) -> None:
        pass

    async def send(self, session_id: str, text: str) -> None:
        raise RuntimeError("This agent accepts no prompts from outside.")


# ---------------------------------------------------------------------------
# Claude Code
# ---------------------------------------------------------------------------


def _claude_dir() -> str:
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


class ClaudeProvider(Provider):
    """Claude Code: live registry in ``sessions/<pid>.json``, transcripts in
    ``projects/<encoded cwd>/<session id>.jsonl``, an inbox socket per session."""

    agent = "claude"

    def _registry(self) -> list[Record]:
        records: list[Record] = []
        for path in glob.glob(os.path.join(_claude_dir(), "sessions", "*.json")):
            try:
                with open(path, encoding="utf-8") as handle:
                    record = json.load(handle)
            except (OSError, ValueError):
                continue
            if isinstance(record, dict) and isinstance(record.get("sessionId"), str):
                records.append(record)
        return records

    def _alive(self, record: Record) -> bool:
        proc = _process(record.get("pid"))
        if proc is None:
            return False
        try:
            return "claude" in proc.name().lower() or any(
                "claude" in os.path.basename(part) for part in proc.cmdline()[:1]
            )
        except Exception:
            return False

    def _find(self, session_id: str) -> Record | None:
        for record in self._registry():
            if record.get("sessionId") == session_id and self._alive(record):
                return record
        return None

    def transcript_path(self, session_id: str) -> str | None:
        if not re.fullmatch(r"[0-9a-fA-F-]{8,}", session_id):
            return None
        matches = glob.glob(os.path.join(_claude_dir(), "projects", "*", f"{session_id}.jsonl"))
        return max(matches, key=os.path.getmtime) if matches else None

    def sessions(self, root: str, exclude_pids: set[int]) -> list[ExternalSession]:
        result: list[ExternalSession] = []
        for record in self._registry():
            cwd = record.get("cwd")
            pid = record.get("pid")
            if not isinstance(cwd, str) or pid in exclude_pids or not self._alive(record):
                continue
            subpath = _within(root, cwd)
            if subpath is None:
                continue
            session_id = record["sessionId"]
            transcript = self.transcript_path(session_id)
            session = ExternalSession(
                id=f"claude:{session_id}",
                agent=self.agent,
                cwd=cwd,
                name=str(record.get("name") or session_id[:8]),
                status=str(record.get("status") or "unknown"),
                pid=pid if isinstance(pid, int) else None,
                sessionId=session_id,
                startedAt=(record["startedAt"] / 1000)
                if isinstance(record.get("startedAt"), (int, float))
                else None,
                transcript=transcript is not None,
                send=isinstance(record.get("messagingSocketPath"), str)
                and os.path.exists(record["messagingSocketPath"]),
                subpath=subpath or None,
            )
            if transcript:
                for tail in _tail_records(transcript):
                    if tail.get("type") == "ai-title" and isinstance(tail.get("aiTitle"), str):
                        session.title = tail["aiTitle"]
                    elif tail.get("type") == "last-prompt" and isinstance(
                        tail.get("lastPrompt"), str
                    ):
                        session.lastPrompt = _preview(tail["lastPrompt"])
            result.append(session)
        return result

    def parse(self, record: Record, entries: list[Entry]) -> None:
        kind = record.get("type")
        if record.get("isSidechain") or record.get("isMeta"):
            return
        message = record.get("message")
        ts = record.get("timestamp")
        if kind == "user" and isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                text = _clean_user_text(content)
                if text:
                    _push(entries, _entry("user", text, ts=ts))
                return
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                block_type = block.get("type")
                if block_type == "text":
                    text = _clean_user_text(str(block.get("text") or ""))
                    if text:
                        _push(entries, _entry("user", text, ts=ts))
                elif block_type == "tool_result":
                    output = _text_blocks(block.get("content"))
                    entries.append(
                        _entry(
                            "result",
                            _clip(output, RESULT_MAX_CHARS),
                            name="error" if block.get("is_error") else None,
                            ts=ts,
                            call_id=block.get("tool_use_id"),
                        )
                    )
                elif block_type == "image":
                    _push(entries, _entry("user", "[image]", ts=ts))
        elif kind == "assistant" and isinstance(message, dict):
            for block in message.get("content") or []:
                if not isinstance(block, dict):
                    continue
                block_type = block.get("type")
                if block_type == "text":
                    text = str(block.get("text") or "").strip()
                    if text:
                        _push(entries, _entry("assistant", text, ts=ts))
                elif block_type == "tool_use":
                    name = str(block.get("name") or "tool")
                    entries.append(
                        _entry(
                            "tool",
                            _summarize_input(name, block.get("input")),
                            name=name,
                            ts=ts,
                            call_id=block.get("id"),
                            tool_input=block.get("input"),
                        )
                    )
        elif kind == "ai-title" and isinstance(record.get("aiTitle"), str):
            entries.append(_entry("title", record["aiTitle"]))

    async def send(self, session_id: str, text: str) -> None:
        record = self._find(session_id)
        path = record.get("messagingSocketPath") if record else None
        if not isinstance(path, str) or not os.path.exists(path):
            raise RuntimeError("The Claude Code session has no inbox socket.")
        if not hasattr(socket, "AF_UNIX"):
            raise RuntimeError("Unix sockets are not available on this platform.")
        line = json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n"

        def deliver() -> None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(5)
                sock.connect(path)
                sock.sendall(line.encode("utf-8"))
                # The session may answer with a receipt; wait briefly so the
                # write is flushed before the socket closes, then move on.
                sock.settimeout(1)
                try:
                    sock.recv(4096)
                except OSError:
                    pass

        await asyncio.get_running_loop().run_in_executor(None, deliver)


# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------


def _codex_dir() -> str:
    return os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")


class CodexProvider(Provider):
    """Codex: TUI processes found by cwd, matched to the rollout file the
    shared daemon writes for their thread; ``codex queue`` delivers prompts."""

    agent = "codex"

    def _rollouts(self) -> list[str]:
        return glob.glob(os.path.join(_codex_dir(), "sessions", "*", "*", "*", "rollout-*.jsonl"))

    def _thread_names(self) -> dict[str, str]:
        names: dict[str, str] = {}
        for record in _tail_records(os.path.join(_codex_dir(), "session_index.jsonl"), 256 * 1024):
            thread_id = record.get("id")
            name = record.get("thread_name")
            if isinstance(thread_id, str) and isinstance(name, str) and name:
                names[thread_id] = name
        return names

    @staticmethod
    def _thread_id(path: str) -> str | None:
        match = re.search(r"-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", path)
        return match.group(1) if match else None

    def transcript_path(self, session_id: str) -> str | None:
        if not re.fullmatch(r"[0-9a-f-]{36}", session_id):
            return None
        matches = glob.glob(
            os.path.join(_codex_dir(), "sessions", "*", "*", "*", f"rollout-*-{session_id}.jsonl")
        )
        return max(matches, key=os.path.getmtime) if matches else None

    @staticmethod
    def _meta(path: str) -> Record | None:
        try:
            with open(path, encoding="utf-8") as handle:
                first = handle.readline()
            record = json.loads(first)
        except (OSError, ValueError):
            return None
        if not isinstance(record, dict) or record.get("type") != "session_meta":
            return None
        payload = record.get("payload")
        return payload if isinstance(payload, dict) else None

    def _processes(self, root: str, exclude_pids: set[int]) -> list[tuple[Any, str]]:
        found: list[tuple[Any, str]] = []
        if psutil is None:
            return found
        for proc in psutil.process_iter(["pid", "name", "cmdline", "cwd"]):
            try:
                if proc.info["pid"] in exclude_pids:
                    continue
                name = (proc.info["name"] or "").lower()
                cmdline = proc.info["cmdline"] or []
                argv = [os.path.basename(part) for part in cmdline[:2]]
                if not (name.startswith("codex") or "codex" in argv or "codex.js" in argv):
                    continue
                # Skip helpers and the daemon: only the interactive TUI counts.
                if any(part in ("app-server", "exec", "mcp", "mcp-server", "queue") for part in cmdline[1:3]):
                    continue
                cwd = proc.info["cwd"]
                if cwd and _within(root, cwd) is not None:
                    found.append((proc, cwd))
            except Exception:
                continue
        # The node wrapper script spawns the native binary as its child with
        # the same cwd; keep only the child so one TUI is one session.
        pids = {proc.pid for proc, _ in found}
        for proc, _ in found:
            try:
                pids.discard(proc.ppid())
            except Exception:
                continue
        return [(proc, cwd) for proc, cwd in found if proc.pid in pids]

    @staticmethod
    def _argv_thread(proc: Any) -> str | None:
        """The thread id named on a ``codex resume <id>`` / ``fork <id>`` command line."""
        try:
            cmdline = proc.cmdline()
        except Exception:
            return None
        for index, part in enumerate(cmdline):
            if part in ("resume", "fork") and index + 1 < len(cmdline):
                candidate = cmdline[index + 1]
                if re.fullmatch(r"[0-9a-f-]{36}", candidate):
                    return candidate
        return None

    def sessions(self, root: str, exclude_pids: set[int]) -> list[ExternalSession]:
        procs = self._processes(root, exclude_pids)
        if not procs:
            return []
        rollouts: list[tuple[float, str]] = []
        for path in self._rollouts():
            try:
                rollouts.append((os.path.getmtime(path), path))
            except OSError:
                continue
        rollouts.sort(reverse=True)
        names = self._thread_names()
        claimed: set[str] = set()
        result: list[ExternalSession] = []
        for proc, cwd in sorted(procs, key=lambda item: _created(item[0]) or 0):
            created = _created(proc) or 0
            match: str | None = None
            # A resumed thread is named on the command line; a fresh one only
            # gets its rollout file (in this cwd) once the first turn starts.
            named = self._argv_thread(proc)
            if named:
                match = self.transcript_path(named)
            for mtime, path in rollouts if match is None else []:
                if path in claimed or mtime < created - 5:
                    continue
                meta = self._meta(path)
                if not meta or os.path.realpath(str(meta.get("cwd") or "")) != os.path.realpath(cwd):
                    continue
                match = path
                break
            subpath = _within(root, cwd)
            thread_id = self._thread_id(match) if match else None
            session = ExternalSession(
                id=f"codex:{thread_id}" if thread_id else f"codex:pid:{proc.pid}",
                agent=self.agent,
                cwd=cwd,
                name=names.get(thread_id or "", "") or (thread_id[:8] if thread_id else f"pid {proc.pid}"),
                pid=proc.pid,
                sessionId=thread_id,
                startedAt=created or None,
                transcript=match is not None,
                send=thread_id is not None and which("codex") is not None,
                attach=f"codex resume {thread_id}" if thread_id else None,
                subpath=subpath or None,
            )
            if match:
                claimed.add(match)
                self._summarize(match, session)
            result.append(session)
        return result

    def _summarize(self, path: str, session: ExternalSession) -> None:
        for record in _tail_records(path):
            payload = record.get("payload")
            if not isinstance(payload, dict):
                continue
            kind = record.get("type")
            if kind == "event_msg":
                event = payload.get("type")
                if event == "task_started":
                    session.status = "busy"
                elif event in ("task_complete", "turn_aborted"):
                    session.status = "idle"
                elif event == "user_message" and isinstance(payload.get("message"), str):
                    text = _clean_user_text(payload["message"])
                    if text:
                        session.lastPrompt = _preview(text)
            elif kind == "response_item" and payload.get("type") == "message" and payload.get("role") == "user":
                text = _clean_user_text(_text_blocks(payload.get("content")))
                if text:
                    session.lastPrompt = _preview(text)

    def parse(self, record: Record, entries: list[Entry]) -> None:
        kind = record.get("type")
        payload = record.get("payload")
        ts = record.get("timestamp")
        if not isinstance(payload, dict):
            return
        if kind == "response_item":
            item = payload.get("type")
            if item == "message":
                role = payload.get("role")
                text = _text_blocks(payload.get("content"))
                if role == "user":
                    cleaned = _clean_user_text(text)
                    if cleaned:
                        _push(entries, _entry("user", cleaned, ts=ts))
                elif role == "assistant" and text.strip():
                    _push(entries, _entry("assistant", text.strip(), ts=ts))
            elif item in ("function_call", "custom_tool_call"):
                name = str(payload.get("name") or "tool")
                value = payload.get("arguments") if item == "function_call" else payload.get("input")
                entries.append(
                    _entry(
                        "tool",
                        _summarize_input(name, value),
                        name=name,
                        ts=ts,
                        call_id=payload.get("call_id"),
                        tool_input=value,
                    )
                )
            elif item in ("function_call_output", "custom_tool_call_output"):
                output = _text_blocks(payload.get("output"))
                entries.append(
                    _entry(
                        "result",
                        _clip(output, RESULT_MAX_CHARS),
                        ts=ts,
                        call_id=payload.get("call_id"),
                    )
                )
        elif kind == "event_msg":
            event = payload.get("type")
            if event == "user_message" and isinstance(payload.get("message"), str):
                cleaned = _clean_user_text(payload["message"])
                if cleaned:
                    _push(entries, _entry("user", cleaned, ts=ts))
            elif event == "agent_message" and isinstance(payload.get("message"), str):
                if payload["message"].strip():
                    _push(entries, _entry("assistant", payload["message"].strip(), ts=ts))
            elif event == "task_started":
                entries.append(_entry("status", "busy"))
            elif event in ("task_complete", "turn_aborted"):
                entries.append(_entry("status", "idle"))

    async def send(self, session_id: str, text: str) -> None:
        codex = which("codex")
        if codex is None:
            raise RuntimeError("The codex command is not on PATH.")
        if not re.fullmatch(r"[0-9a-f-]{36}", session_id):
            raise RuntimeError("Unknown Codex thread.")
        process = await asyncio.create_subprocess_exec(
            codex,
            "queue",
            "--thread",
            session_id,
            "--message",
            text,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
        except asyncio.TimeoutError:
            process.kill()
            raise RuntimeError("codex queue timed out.")
        if process.returncode != 0:
            detail = (stderr or stdout).decode("utf-8", "replace").strip()
            raise RuntimeError(detail.splitlines()[-1] if detail else "codex queue failed.")


# ---------------------------------------------------------------------------
# pi
# ---------------------------------------------------------------------------


def _pi_dir() -> str:
    return os.environ.get("PI_CODING_AGENT_DIR") or os.path.expanduser("~/.pi/agent")


class PiProvider(Provider):
    """pi: processes found by cwd, matched to the newest session file written
    for that folder since the process started. Read-only."""

    agent = "pi"

    def _session_files(self) -> list[str]:
        return glob.glob(os.path.join(_pi_dir(), "sessions", "*", "*.jsonl"))

    @staticmethod
    def _meta(path: str) -> Record | None:
        try:
            with open(path, encoding="utf-8") as handle:
                record = json.loads(handle.readline())
        except (OSError, ValueError):
            return None
        return record if isinstance(record, dict) and record.get("type") == "session" else None

    def transcript_path(self, session_id: str) -> str | None:
        if not re.fullmatch(r"[0-9a-f-]{36}", session_id):
            return None
        matches = glob.glob(os.path.join(_pi_dir(), "sessions", "*", f"*_{session_id}.jsonl"))
        return max(matches, key=os.path.getmtime) if matches else None

    def sessions(self, root: str, exclude_pids: set[int]) -> list[ExternalSession]:
        if psutil is None:
            return []
        procs: list[tuple[Any, str]] = []
        for proc in psutil.process_iter(["pid", "name", "cmdline", "cwd"]):
            try:
                if proc.info["pid"] in exclude_pids:
                    continue
                cmdline = proc.info["cmdline"] or []
                argv = [os.path.basename(part) for part in cmdline[:2]]
                if (proc.info["name"] or "") != "pi" and "pi" not in argv:
                    continue
                if any(part in ("install", "update", "list", "config", "auth", "mcp") for part in cmdline[1:2]):
                    continue
                cwd = proc.info["cwd"]
                if cwd and _within(root, cwd) is not None:
                    procs.append((proc, cwd))
            except Exception:
                continue
        if not procs:
            return []
        files = sorted(self._session_files(), key=lambda p: -os.path.getmtime(p))
        claimed: set[str] = set()
        result: list[ExternalSession] = []
        for proc, cwd in sorted(procs, key=lambda item: _created(item[0]) or 0):
            created = _created(proc) or 0
            match: str | None = None
            for path in files:
                if path in claimed or os.path.getmtime(path) < created - 5:
                    continue
                meta = self._meta(path)
                if meta and os.path.realpath(str(meta.get("cwd") or "")) == os.path.realpath(cwd):
                    match = path
                    break
            session_id = (self._meta(match) or {}).get("id") if match else None
            session = ExternalSession(
                id=f"pi:{session_id}" if session_id else f"pi:pid:{proc.pid}",
                agent=self.agent,
                cwd=cwd,
                name=str(session_id)[:8] if session_id else f"pid {proc.pid}",
                pid=proc.pid,
                sessionId=str(session_id) if session_id else None,
                startedAt=created or None,
                transcript=match is not None,
                subpath=_within(root, cwd) or None,
            )
            if match:
                claimed.add(match)
                for record in _tail_records(match):
                    message = record.get("message")
                    if record.get("type") == "message" and isinstance(message, dict):
                        if message.get("role") == "user":
                            text = _clean_user_text(_text_blocks(message.get("content")))
                            if text:
                                session.lastPrompt = _preview(text)
                            session.status = "busy"
                        elif message.get("role") == "assistant":
                            session.status = "idle"
            result.append(session)
        return result

    def parse(self, record: Record, entries: list[Entry]) -> None:
        if record.get("type") != "message":
            return
        message = record.get("message")
        if not isinstance(message, dict):
            return
        role = message.get("role")
        ts = record.get("timestamp")
        content = message.get("content")
        if role == "user":
            text = _clean_user_text(_text_blocks(content))
            if text:
                _push(entries, _entry("user", text, ts=ts))
        elif role == "assistant":
            if isinstance(content, str):
                if content.strip():
                    _push(entries, _entry("assistant", content.strip(), ts=ts))
                return
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and str(block.get("text") or "").strip():
                    _push(entries, _entry("assistant", str(block["text"]).strip(), ts=ts))
                elif block.get("type") == "toolCall":
                    name = str(block.get("name") or "tool")
                    entries.append(
                        _entry(
                            "tool",
                            _summarize_input(name, block.get("arguments")),
                            name=name,
                            ts=ts,
                            call_id=block.get("id"),
                            tool_input=block.get("arguments"),
                        )
                    )
        elif role == "toolResult":
            entries.append(
                _entry(
                    "result",
                    _clip(_text_blocks(content), RESULT_MAX_CHARS),
                    name="error" if message.get("isError") else None,
                    ts=ts,
                    call_id=message.get("toolCallId"),
                )
            )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

PROVIDERS: dict[str, Provider] = {
    provider.agent: provider for provider in (ClaudeProvider(), CodexProvider(), PiProvider())
}


def split_id(session_id: str) -> tuple[Provider, str] | None:
    """Resolve ``<agent>:<session id>`` to its provider and bare id."""
    agent, _, rest = session_id.partition(":")
    provider = PROVIDERS.get(agent)
    if provider is None or not rest or rest.startswith("pid:"):
        return None
    return provider, rest


def list_sessions(root: str, exclude_pids: set[int]) -> list[ExternalSession]:
    """Every external session for `root` (or a folder inside it), across providers."""
    sessions: list[ExternalSession] = []
    for provider in PROVIDERS.values():
        try:
            sessions.extend(provider.sessions(root, exclude_pids))
        except Exception:
            # One misbehaving provider must not hide the others.
            continue
    sessions.sort(key=lambda s: s.startedAt or 0)
    return sessions


def terminal_pids(manager: Any) -> set[int]:
    """Pids of every process running under one of the server's own terminals."""
    pids: set[int] = set()
    if manager is None or psutil is None:
        return pids
    for pty in list(getattr(manager, "terminals", {}).values()):
        pid = getattr(getattr(pty, "ptyproc", None), "pid", None)
        proc = _process(pid)
        if proc is None:
            continue
        pids.add(proc.pid)
        try:
            pids.update(child.pid for child in proc.children(recursive=True))
        except Exception:
            continue
    return pids
