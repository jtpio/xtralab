"""A no-op checkpoints manager for xtralab.

By default Jupyter's ``AsyncFileCheckpoints`` writes a ``.ipynb_checkpoints``
directory next to every document the moment it is opened or saved, cluttering
the working tree and the file browser. xtralab does not surface checkpoints in
its UI, so ``NullCheckpoints`` replaces that manager and keeps the filesystem
clean.

The contents REST API still exposes the checkpoint endpoints (and the JupyterLab
frontend calls ``create_checkpoint`` after every save), so the methods stay live
but do nothing: creating a checkpoint returns a placeholder model, listing
returns an empty list, and restore/rename/delete are no-ops. It is wired in via
the ``ContentsManager.checkpoints_class`` setting shipped in
``jupyter-config/jupyter_server_config.d/xtralab-checkpoints.json``.

``AsyncCheckpoints`` is the async base the default ``AsyncLargeFileManager``
expects, so its checkpoint calls are awaited.
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
