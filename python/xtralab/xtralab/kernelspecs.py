"""
Kernels of the environments of the folder that the server runs in.
"""

from __future__ import annotations

import glob
import os
import shutil

from jupyter_client.kernelspec import KernelSpec, KernelSpecManager
from traitlets import Bool, Unicode

ENVIRONMENTS = (".venv", "venv", "env", ".conda")
PIXI_ENVIRONMENTS = os.path.join(".pixi", "envs", "*")
BIN = "Scripts" if os.name == "nt" else "bin"


class ProjectKernelSpecManager(KernelSpecManager):
    """
    Kernel specs that include the kernels of the environments of the server folder.

    The kernels of an environment are the kernel specs in its
    `share/jupyter/kernels` folder, for all languages.
    """

    project_environments = Bool(
        True,
        config=True,
        help="""
        Add the kernels of the environments of the server folder. They replace
        the kernels of the same name from the other locations.
        """,
    )

    root_dir = Unicode()

    def _root_dir_default(self) -> str:
        return getattr(self.parent, "root_dir", None) or os.getcwd()

    def _environments(self) -> list[str]:
        """
        The possible roots of the environments of the server folder.
        """
        if not self.project_environments:
            return []
        roots = [os.path.join(self.root_dir, name) for name in ENVIRONMENTS]
        pixi = os.path.join(glob.escape(self.root_dir), PIXI_ENVIRONMENTS)
        return roots + sorted(glob.glob(pixi))

    def _kernel_dirs_default(self) -> list[str]:
        dirs = [
            os.path.join(root, "share", "jupyter", "kernels")
            for root in self._environments()
        ]
        return dirs + super()._kernel_dirs_default()

    def get_kernel_spec(self, kernel_name: str) -> KernelSpec:
        spec = super().get_kernel_spec(kernel_name)
        for root in self._environments():
            if not spec.resource_dir.startswith(os.path.join(root, "")):
                continue
            # Start the kernel as in the active environment: a kernel spec can
            # name a command, such as `python` or `R`, without its folder.
            bin_dir = os.path.join(root, BIN)
            if spec.argv:
                spec.argv[0] = shutil.which(spec.argv[0], path=bin_dir) or spec.argv[0]
            env = {"PATH": os.pathsep.join([bin_dir, "${PATH}"])}
            if os.path.isfile(os.path.join(root, "pyvenv.cfg")):
                env["VIRTUAL_ENV"] = root
            spec.env = {**env, **spec.env}
            label = os.path.relpath(root, self.root_dir).replace(os.sep, "/")
            spec.display_name += f" [{label}]"
        return spec
