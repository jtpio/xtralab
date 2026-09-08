"""A Y-updates store that stores nothing.

Agents edit files out-of-band, so a room restored from stored Yjs history
diverges from disk, and a reconnecting client can then panic pycrdt's Rust
layer (document renders with empty cells). ``read()`` raising ``YDocNotFound``
rebuilds every room from disk via the deterministic ``Doc(client_id=0)`` path;
live collaboration is untouched, only history across restarts is lost.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from logging import Logger, getLogger

from pycrdt.store import BaseYStore, YDocNotFound


class NoYStore(BaseYStore):
    """A YStore that persists nothing and always reports an empty document.

    ``YDocExtension.ystore_class`` requires a ``BaseYStore`` subclass, so
    disabling persistence means a store that stores nothing.
    """

    def __init__(
        self,
        path: str,
        metadata_callback: Callable[[], Awaitable[bytes] | bytes] | None = None,
        log: Logger | None = None,
        **kwargs,
    ) -> None:
        # kwargs swallows the ``config`` the extension passes to every store.
        self.path = path
        self.metadata_callback = metadata_callback
        self.log = log or getLogger(__name__)

    async def write(self, data: bytes) -> None:
        """Discard the update."""

    async def read(self) -> AsyncIterator[tuple[bytes, bytes, float]]:
        """Report an empty store, so the room loads its content from disk."""
        raise YDocNotFound(self.path)
        yield  # pragma: no cover - unreachable, but makes this a generator
