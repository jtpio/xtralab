---
name: open
description: Start xtralab (JupyterLab) in a folder from the terminal and open it in the browser. Use when the user asks to open, start, launch, or show xtralab or JupyterLab for a folder, a git worktree, or the current project, for example "open xtralab in this worktree", "start xtralab here", "show me these changes in xtralab". Runs xtralab with uvx in its own cached environment, so nothing is installed into the project. Prints the URL, reuses a server that already serves the folder, and can upgrade xtralab to the latest release.
compatibility: Requires uv (the `uvx` command) on PATH and network access on the first run, which downloads xtralab. The browser opens on the same machine as the agent.
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/open.sh *)
---

# Open xtralab in a folder

Starts an xtralab server for one folder with `uvx --from xtralab jupyter-lab`,
detached from the agent session, and opens a browser tab on it. The user can
then browse the files, see diffs, and start other agents from the xtralab
terminals while the current agent session continues in the terminal.

## Steps

1. Pick the folder: the argument of the command, or the folder the user named,
   or the current working directory. For a git worktree, use the worktree path,
   not the main checkout.

2. Run the launcher from this skill's folder, with a 10 minute timeout
   (the first run downloads xtralab and its dependencies):

   ```bash
   scripts/open.sh [--upgrade] <folder>
   ```

   Run it as a normal foreground command, not as a background task: the
   script returns as soon as the server prints its URL, and the server
   continues to run after the agent session ends.

3. Report the lines the script prints: the URL, the folder, the log file, and
   the stop command. Do not open the browser yourself: the server opens it.

## Behavior

- A server that already serves the folder is reused. The script prints its URL
  and does not start a second server.
- `--upgrade` resolves the latest xtralab release before the start. Without it,
  uvx reuses the cached environment. Pass it when the user asks to update or
  upgrade xtralab.
- The folder becomes the root of the file browser. Files outside it are not
  visible in xtralab.
- The server keeps the default Jupyter configuration of the user:
  `~/.jupyter` for settings and `~/Library/Jupyter` (macOS) or `~/.local/share/jupyter`
  (Linux) for data. These are shared with other JupyterLab installations.
- To stop the server, run the stop command the script printed, or close the
  tab and run `uvx --from xtralab jupyter-lab stop <port>`.
- To drive the new server with the `jupyter` MCP tools, the MCP proxy must
  connect to it: reconnect the server (in Claude Code, `/mcp`) or start a new
  agent session in the same folder.

## Troubleshooting

- `uv is not installed`: install uv from https://docs.astral.sh/uv/ and run the
  command again.
- The script fails under a sandbox: uvx writes to its cache outside the project
  and the server listens on a port. Run the command outside the sandbox.
- uv warns that `jupyter-lab` comes from `jupyterlab`, not from `xtralab`. This
  warning is expected. Do not switch to `--from jupyterlab`: that removes
  xtralab from the environment.
