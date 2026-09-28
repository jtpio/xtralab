"""``/xtralab/git/review``: the changed files and the patch for the review tab.

The ``uncommitted`` scope compares HEAD with the working tree. The ``branch``
scope compares the merge-base with a base branch with the working tree, so
uncommitted work is part of the branch. Untracked files come with a
synthesized "new file" patch because ``git diff`` does not list them.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import ApiPath, to_os_path
from tornado.web import HTTPError, authenticated

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

FALLBACK_BASES = ("main", "master", "origin/main", "origin/master")

# Past these sizes the file stays in the list but gets no patch.
MAX_PATCH_LINES = 20_000
MAX_UNTRACKED_BYTES = 1_000_000

BINARY_SNIFF_BYTES = 8000

NOTEBOOK_EXCLUDE = ":(exclude,glob)**/*.ipynb"

STATUS_NAMES = {
    "A": "added",
    "C": "added",
    "D": "deleted",
    "M": "modified",
    "R": "renamed",
    "T": "typechange",
    "U": "unmerged",
}

GIT_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",
    # A polled ``git diff`` must not take the index lock from the user's git.
    "GIT_OPTIONAL_LOCKS": "0",
    "LC_ALL": "C",
}


class GitError(Exception):
    """A git command failed."""


async def _git(cwd: str, *args: str) -> str:
    def run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["git", *args],
            cwd=cwd,
            env=GIT_ENV,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
        )

    proc = await asyncio.to_thread(run)
    if proc.returncode != 0:
        raise GitError(proc.stderr.decode("utf-8", "replace").strip())
    return proc.stdout.decode("utf-8", "replace")


async def _git_optional(cwd: str, *args: str) -> str | None:
    try:
        return (await _git(cwd, *args)).strip() or None
    except GitError:
        return None


def _split_z(output: str) -> list[str]:
    parts = output.split("\0")
    if parts and parts[-1] == "":
        parts.pop()
    return parts


def _parse_name_status(output: str) -> list[dict]:
    parts = _split_z(output)
    files = []
    i = 0
    while i < len(parts):
        code = parts[i]
        letter = code[:1]
        if letter in ("R", "C"):
            old, new = parts[i + 1], parts[i + 2]
            i += 3
        else:
            old, new = None, parts[i + 1]
            i += 2
        entry = {"path": new, "status": STATUS_NAMES.get(letter, "modified")}
        if letter == "R":
            entry["from"] = old
        files.append(entry)
    return files


def _parse_numstat(output: str) -> dict[str, tuple[int, int, bool]]:
    """Map each new path to ``(additions, deletions, binary)``."""
    parts = _split_z(output)
    stats: dict[str, tuple[int, int, bool]] = {}
    i = 0
    while i < len(parts):
        fields = parts[i].split("\t", 2)
        if len(fields) < 3:
            i += 1
            continue
        added, deleted, path = fields
        if path == "":
            # A rename: the old and the new path follow as separate fields.
            path = parts[i + 2]
            i += 3
        else:
            i += 1
        binary = added == "-" and deleted == "-"
        stats[path] = (
            0 if binary else int(added),
            0 if binary else int(deleted),
            binary,
        )
    return stats


def _synthesize_untracked(toplevel: str, path: str) -> tuple[dict, str | None]:
    """The list entry and, for a small text file, a "new file" patch."""
    entry: dict = {
        "path": path,
        "status": "untracked",
        "additions": 0,
        "deletions": 0,
        "binary": False,
    }
    full = os.path.join(toplevel, path)
    try:
        stat = os.lstat(full)
        if not os.path.isfile(full) or os.path.islink(full):
            return entry, None
        if stat.st_size > MAX_UNTRACKED_BYTES:
            entry["tooLarge"] = True
            return entry, None
        with open(full, "rb") as f:
            data = f.read()
    except OSError:
        return entry, None
    if b"\0" in data[:BINARY_SNIFF_BYTES]:
        entry["binary"] = True
        return entry, None
    text = data.decode("utf-8", "replace")
    # Split on "\n" only, like git; splitlines() also breaks on "\r" and more.
    lines = [line + "\n" for line in text.split("\n")]
    lines[-1] = lines[-1][:-1]
    if lines[-1] == "":
        lines.pop()
    entry["additions"] = len(lines)
    if path.endswith(".ipynb") or any(c in path for c in '"\\\t\n'):
        return entry, None
    mode = "100755" if stat.st_mode & 0o111 else "100644"
    chunk = [f"diff --git a/{path} b/{path}\n", f"new file mode {mode}\n"]
    if lines:
        chunk.append("--- /dev/null\n")
        chunk.append(f"+++ b/{path}\n")
        chunk.append(f"@@ -0,0 +1,{len(lines)} @@\n")
        chunk.extend(f"+{line}" for line in lines)
        if not lines[-1].endswith("\n"):
            chunk.append("\n\\ No newline at end of file\n")
    return entry, "".join(chunk)


async def _default_base(toplevel: str) -> str | None:
    remote_head = await _git_optional(
        toplevel, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"
    )
    if remote_head:
        return remote_head
    for name in FALLBACK_BASES:
        if await _git_optional(toplevel, "rev-parse", "-q", "--verify", name):
            return name
    return None


async def _base_candidates(toplevel: str) -> list[str]:
    output = await _git(
        toplevel,
        "for-each-ref",
        "--format=%(refname)%00%(refname:short)",
        "refs/heads",
        "refs/remotes",
    )
    names = []
    for line in output.splitlines():
        full, _, short = line.partition("\0")
        if not full.endswith("/HEAD"):
            names.append(short)
    return names


async def _toplevel(cwd: str) -> str | None:
    return await _git_optional(cwd, "rev-parse", "--show-toplevel")


async def build_bases(toplevel: str) -> dict:
    """The current branch, the default base and the other branches."""
    branch = await _git_optional(toplevel, "symbolic-ref", "-q", "--short", "HEAD")
    candidates = [c for c in await _base_candidates(toplevel) if c != branch]
    return {
        "branch": branch,
        "defaultBase": await _default_base(toplevel),
        "baseCandidates": candidates,
    }


async def build_review(cwd: str, scope: str, requested_base: str | None) -> dict:
    """Collect the review payload for the repository that contains ``cwd``."""
    toplevel = await _toplevel(cwd)
    if toplevel is None:
        return {"error": "not-a-repository"}

    head = await _git_optional(toplevel, "rev-parse", "-q", "--verify", "HEAD")
    result: dict = {
        "scope": scope,
        "head": head,
        **await build_bases(toplevel),
        "base": None,
        "files": [],
        "patch": "",
        "error": None,
    }

    if scope == "branch":
        base_ref = requested_base or result["defaultBase"]
        if base_ref is None:
            result["error"] = "no-base"
            return result
        if head is None:
            result["error"] = "no-commits"
            return result
        result["base"] = {"ref": base_ref, "sha": None}
        if not await _git_optional(
            toplevel, "rev-parse", "-q", "--verify", f"{base_ref}^{{commit}}"
        ):
            result["error"] = "unknown-base"
            return result
        try:
            base_sha = (await _git(toplevel, "merge-base", base_ref, "HEAD")).strip()
        except GitError:
            result["error"] = "no-merge-base"
            return result
    else:
        base_ref = "HEAD"
        base_sha = head or EMPTY_TREE
    result["base"] = {"ref": base_ref, "sha": base_sha}

    diff_args = ("-M", "--no-color", "--no-ext-diff", "--no-textconv")
    name_status, numstat = await asyncio.gather(
        _git(toplevel, "diff", *diff_args, "--name-status", "-z", base_sha),
        _git(toplevel, "diff", *diff_args, "--numstat", "-z", base_sha),
    )
    stats = _parse_numstat(numstat)
    files = _parse_name_status(name_status)
    excluded = []
    for entry in files:
        additions, deletions, binary = stats.get(entry["path"], (0, 0, False))
        entry.update(additions=additions, deletions=deletions, binary=binary)
        if additions + deletions > MAX_PATCH_LINES:
            entry["tooLarge"] = True
            excluded.append(f":(exclude,literal){entry['path']}")

    patch = ""
    if files:
        patch = await _git(
            toplevel,
            "-c",
            "core.quotePath=false",
            "diff",
            *diff_args,
            "--src-prefix=a/",
            "--dst-prefix=b/",
            base_sha,
            "--",
            ".",
            NOTEBOOK_EXCLUDE,
            *excluded,
        )

    untracked = _split_z(
        await _git(toplevel, "ls-files", "--others", "--exclude-standard", "-z")
    )
    chunks = [patch]
    for path in untracked:
        if path.endswith("/"):
            # A nested repository.
            continue
        entry, chunk = _synthesize_untracked(toplevel, path)
        files.append(entry)
        if chunk is not None:
            chunks.append(chunk)

    result["files"] = files
    result["patch"] = "".join(chunks)
    return result


def _repo_cwd(handler: APIHandler, path: object) -> str:
    """The local folder of a server-relative path, kept inside the root."""
    if not isinstance(path, str):
        raise HTTPError(400, "Expected a string 'path'")
    root = os.path.realpath(handler.contents_manager.root_dir)
    cwd = os.path.realpath(to_os_path(ApiPath(path), root))
    if os.path.commonpath([root, cwd]) != root:
        raise HTTPError(404, "Path outside the server root")
    return cwd


class GitBasesHandler(APIHandler):
    """Return the branches a review can compare with."""

    @authenticated
    async def get(self) -> None:
        cwd = _repo_cwd(self, self.get_query_argument("path", ""))
        toplevel = await _toplevel(cwd)
        if toplevel is None:
            self.finish(json.dumps({"error": "not-a-repository"}))
            return
        self.finish(json.dumps({**await build_bases(toplevel), "error": None}))


class GitReviewHandler(APIHandler):
    """Return the changed files and the patch of one review scope."""

    @authenticated
    async def post(self) -> None:
        body = self.get_json_body() or {}
        scope = body.get("scope", "uncommitted")
        base = body.get("base")
        etag = body.get("etag")
        if scope not in ("uncommitted", "branch") or (
            base is not None and not isinstance(base, str)
        ):
            raise HTTPError(400, "Expected a 'scope' and an optional string 'base'")
        if base is not None and base.startswith("-"):
            raise HTTPError(400, "Invalid base")
        cwd = _repo_cwd(self, body.get("path", ""))
        result = await build_review(cwd, scope, base)
        payload = json.dumps(result)
        digest = hashlib.sha1(payload.encode("utf-8")).hexdigest()
        if etag == digest:
            self.finish(json.dumps({"etag": digest, "unchanged": True}))
            return
        result["etag"] = digest
        self.finish(json.dumps(result))
