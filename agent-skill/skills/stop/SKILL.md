---
name: stop
description: Stop the xtralab (JupyterLab) server that serves a folder, stop all xtralab servers, or list the running ones. Use when the user asks to stop, close, shut down, or kill xtralab or JupyterLab for a folder, a git worktree, or the current project, or asks which xtralab servers run, for example "stop xtralab", "close the xtralab server for this worktree", "stop all xtralab servers", "which xtralab servers are running?". Runs `uvx xtralab stop` and `uvx xtralab list`, which find servers by folder, so no port is needed.
compatibility: Requires uv (the `uvx` command) on PATH.
allowed-tools: Bash(uvx xtralab *) Bash(uvx xtralab@latest *)
---

# Stop or list xtralab servers

`xtralab stop <folder>` finds the server whose root is the folder and asks it
to shut down. Kernels and terminals of that server stop with it. The browser
tab stays open and shows that the server is gone. `xtralab list` shows every
running xtralab server with its folder, URL, MCP URL, and stop command.

## Steps

1. Pick the scope:
   - One folder: the argument of the command, or the folder the user named, or
     the current working directory. For a git worktree, use the worktree path.
   - All servers: when the user asks to stop all of them, or to clean up.
   - A list: when the user asks which servers run, or has lost track of them.

2. Run one of:

   ```bash
   uvx xtralab stop <folder>
   uvx xtralab stop --all
   uvx xtralab list
   ```

   When the user gives a port instead of a folder, run
   `uvx xtralab stop <port>`.

3. Report the lines the command prints. When no server runs for the folder, the
   command says so and exits with code 1: tell the user, do not look for other
   servers to stop. Before `stop --all`, when the user did not ask for all
   servers explicitly, show the list first and ask.

## Behavior

- `stop <folder>` stops only the server of that folder. Other servers continue
  to run.
- The commands cover xtralab servers only. Other Jupyter servers on the
  machine are not listed and not stopped, also when they serve the folder.
- Each stop waits up to 5 seconds for the server to exit, then reports an
  error if it still runs.
