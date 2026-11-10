"""A no-op checkpoints manager, so saves never write ``.ipynb_checkpoints``.

The frontend calls the checkpoint endpoints after every save, so the methods
stay live but do nothing (``AsyncCheckpoints`` because the contents manager
awaits them). Swapped in at extension load by :mod:`xtralab.server`.
"""

from __future__ import annotations

from datetime import datetime, timezone

from jupyter_server.services.contents.checkpoints import AsyncCheckpoints


class NullCheckpoints(AsyncCheckpoints):
    """Checkpoints manager that never touches the filesystem."""

    async def create_checkpoint(self, contents_mgr, path):
        """Return a placeholder checkpoint model without writing anything."""
        return {"id": "checkpoint", "last_modified": datetime.now(timezone.utc)}

    async def restore_checkpoint(self, contents_mgr, checkpoint_id, path):
        """No checkpoints are stored, so there is nothing to restore."""

    async def rename_checkpoint(self, checkpoint_id, old_path, new_path):
        """No checkpoints are stored, so there is nothing to rename."""

    async def delete_checkpoint(self, checkpoint_id, path):
        """No checkpoints are stored, so there is nothing to delete."""

    async def list_checkpoints(self, path):
        """No checkpoints are ever stored."""
        return []
