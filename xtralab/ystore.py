"""A non-persisting Y updates store for xtralab.

Real-time collaboration keeps every document as a shared Yjs model, and
``jupyter-server-ydoc`` persists that model's update history to an SQLite
"ystore" so a room can be restored after a restart. xtralab is a single-user
workspace where the file on disk is the source of truth, so it keeps the shared
model and drops the history.

Keeping the history is not free here. When a document is reopened after its file
changed on disk — routine in xtralab, since coding agents edit files while the
app is open — ``jupyter_server_ydoc.rooms.DocumentRoom.initialize`` restores the
room from the store and then reconciles it against the file::

    if not loaded_from_store:
        await self._apply_deterministic_source_content(model["content"])
    else:
        await self._document.aset(model["content"])

Only the first branch rebuilds the room deterministically, from a
``Doc(client_id=0)``. The second re-applies the file under a fresh random client
id, producing exactly the divergent history the first branch's own docstring
warns about. A client that later reconnects carrying its own state merges the
two histories, which can panic the Rust CRDT layer inside ``pycrdt``::

    pycrdt/_transaction.py  self._txn.commit()
    pyo3_runtime.PanicException: called `Option::unwrap()` on a `None` value

That panic escapes ``JupyterWebsocketServer.serve()`` and kills the room's task,
so the document never finishes syncing and renders with empty cells.

With nothing stored, ``read()`` raises ``YDocNotFound``, every room is rebuilt
from disk through the deterministic branch, and the divergence cannot arise.
Collaboration itself is untouched: documents are still shared models, and
out-of-band edits still stream into the open UI.

The trade-off is that document history no longer survives a restart, so the
collaboration timeline API has nothing to replay.

It is selected through the ``YDocExtension.ystore_class`` trait. Note that a
``jupyter_server_config.d/*.json`` drop-in cannot do this: those files are read
by :class:`~jupyter_server.extension.config.ExtensionConfigManager` only to
discover which extensions to enable, and their other sections never reach
``ServerApp.config`` — so an ``ExtensionApp`` like ``YDocExtension`` never sees
them. (``jupyter-lsp`` appears to be a counter-example only because it re-reads
those files itself with its own ``ConfigManager``.) It therefore has to be
passed as real traitlets config, which the desktop supervisor does via
``--no-collab-persistence``; see :mod:`xtralab_desktop.app`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from logging import Logger

from pycrdt.store import BaseYStore, YDocNotFound
from traitlets.config import LoggingConfigurable


class _NoYStoreMeta(type(LoggingConfigurable), type(BaseYStore)):  # type: ignore[misc]
    """Reconcile the traitlets and ABC metaclasses, as the shipped stores do."""


class NoYStore(LoggingConfigurable, BaseYStore, metaclass=_NoYStoreMeta):
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
        super().__init__(**kwargs)
        self.path = path
        self.metadata_callback = metadata_callback
        if log is not None:
            self.log = log

    async def write(self, data: bytes) -> None:
        """Discard the update."""

    async def read(self) -> AsyncIterator[tuple[bytes, bytes, float]]:
        """Report an empty store, so the room loads its content from disk."""
        raise YDocNotFound(self.path)
        yield  # pragma: no cover - unreachable, but makes this a generator
