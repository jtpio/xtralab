---
name: stop
description: Stop the xtralab (JupyterLab) server that serves a folder. Use when the user asks to stop, close, shut down, or kill xtralab or JupyterLab for a folder, a git worktree, or the current project, for example "stop xtralab", "close the xtralab server for this worktree", "shut down JupyterLab here". Runs `uvx xtralab stop`, which finds the server by folder, so no port is needed.
compatibility: Requires uv (the `uvx` command) on PATH.
allowed-tools: Bash(uvx xtralab *) Bash(uvx xtralab@latest *)
---

# Stop the xtralab server of a folder

`xtralab stop <folder>` finds the server whose root is the folder and asks it
to shut down. Kernels and terminals of that server stop with it. The browser
tab stays open and shows that the server is gone.

## Steps

1. Pick the folder: the argument of the command, or the folder the user named,
   or the current working directory. For a git worktree, use the worktree path.

2. Run:

   ```bash
   uvx xtralab stop <folder>
   ```

   When the user gives a port instead of a folder, run
   `uvx xtralab stop <port>`.

3. Report the line the command prints. When no server runs for the folder, the
   command says so and exits with code 1: tell the user, do not look for other
   servers to stop.

## Behavior

- Only the server of that folder stops. Servers of other folders continue to
  run. `uvx xtralab list` shows all running servers with their folders.
- The command waits up to 5 seconds for the server to exit, then reports an
  error if it still runs.
