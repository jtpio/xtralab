"""A Y-updates store that stores nothing.

``jupyter-server-ydoc`` persists each document's Yjs update history to an
SQLite "ystore" so a collaboration room can be restored after a restart. In
xtralab the file on disk is the source of truth and coding agents routinely
edit files out-of-band, so a stored history is often stale by the time a room
would be restored from it. Replaying it against the changed file rebuilds the
room with a divergent Yjs history — only rooms built from scratch take the
deterministic ``Doc(client_id=0)`` path in ``jupyter_server_ydoc.rooms`` — and
a client reconnecting with its own state can then panic pycrdt's Rust layer,
killing the room and leaving the document rendered with empty cells.

With nothing stored, ``read()`` raises ``YDocNotFound`` and every room is
rebuilt from disk through the deterministic path. Collaboration itself is
untouched: documents are still shared models and out-of-band edits still
stream into the open UI. The only loss is document history across restarts,
so the collaboration timeline API has nothing to replay.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from logging import Logger, getLogger

from pycrdt.store import BaseYStore, YDocNotFound


class NoYStore(BaseYStore):
    """A YStore that persists nothing and always reports an empty document.

    ``YDocExtension.ystore_class`` is a ``Type`` trait requiring a
    ``BaseYStore`` subclass, so disabling persistence means supplying a store
    that stores nothing rather than unsetting the trait.
    """

    def __init__(
        self,
        path: str,
        metadata_callback: Callable[[], Awaitable[bytes] | bytes] | None = None,
        log: Logger | None = None,
        **kwargs,
    ) -> None:
        # kwargs swallows the ``config`` the extension passes to every store;
        # nothing here is configurable.
        self.path = path
        self.metadata_callback = metadata_callback
        self.log = log or getLogger(__name__)

    async def write(self, data: bytes) -> None:
        """Discard the update."""

    async def read(self) -> AsyncIterator[tuple[bytes, bytes, float]]:
        """Report an empty store, so the room loads its content from disk."""
        raise YDocNotFound(self.path)
        yield  # pragma: no cover - unreachable, but makes this a generator
