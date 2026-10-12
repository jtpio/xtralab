---
name: open
description: Start xtralab (JupyterLab) in a folder from the terminal and open it in the browser. Use when the user asks to open, start, launch, or show xtralab or JupyterLab for a folder, a git worktree, or the current project, for example "open xtralab in this worktree", "start xtralab here", "show me these changes in xtralab". Runs `uvx xtralab open`, so nothing is installed into the project. Prints the URL, reuses a server that already serves the folder, and can update xtralab to the latest release.
compatibility: Requires uv (the `uvx` command) on PATH and network access on the first run, which downloads xtralab. The browser opens on the same machine as the agent.
allowed-tools: Bash(uvx xtralab *) Bash(uvx xtralab@latest *)
---

# Open xtralab in a folder

`xtralab open <folder>` starts an xtralab server for one folder, detached from
the agent session, and the server opens a browser tab. The user can then browse
the files, see diffs, and start other agents from the xtralab terminals while
the current agent session continues in the terminal.

## Steps

1. Pick the folder: the argument of the command, or the folder the user named,
   or the current working directory. For a git worktree, use the worktree path,
   not the main checkout.

2. Run, with a 10 minute timeout (the first run downloads xtralab):

   ```bash
   uvx xtralab open <folder>
   ```

   To update xtralab to the latest release first, run
   `uvx xtralab@latest open <folder>`.

   Run it as a normal foreground command, not as a background task: it returns
   as soon as the server is up, and the server continues to run after the
   agent session ends.

3. Report the lines the command prints: the URL, the folder, the log file, and
   the stop command. Do not open the browser yourself: the server opens it.

## Behavior

- A server that already serves the folder is reused. The command prints its
  URL and does not start a second server.
- The folder becomes the root of the file browser. Files outside it are not
  visible in xtralab.
- The `xtralab` command keeps its JupyterLab settings and Jupyter config in the
  xtralab folder of the user, shared with the xtralab desktop app, not in
  `~/.jupyter`. `xtralab paths` prints the folder.
- To stop the server, run the stop command that was printed:
  `uvx xtralab stop <port>`.
- To drive the new server with the `jupyter` MCP tools, the MCP proxy must
  connect to it: reconnect the server (in Claude Code, `/mcp`) or start a new
  agent session in the same folder.

## Troubleshooting

- `uvx: command not found`: install uv from https://docs.astral.sh/uv/ and run
  the command again.
- The command fails under a sandbox: uvx writes to its cache outside the
  project and the server listens on a port. Run the command outside the
  sandbox.
