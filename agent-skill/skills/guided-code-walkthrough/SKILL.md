---
name: guided-code-walkthrough
description: Use this skill when the user wants you to *show* them something inside the running xtralab (or JupyterLab) app rather than just describe it in chat: open a file in the editor, jump to and highlight specific lines, give a visual tour of the codebase, or render a chart, diagram, table, or explainer into a panel beside the code. Triggers include "walk me through", "show me where", "give me a tour", "open and highlight", "point at", "visualize this", "plot this", "draw a chart of", "explain this code visually", or any request to drive the live UI. Works by sending JupyterLab commands to the connected frontend over the MCP command bridge (the `jupyter` MCP server's `list_all_commands` and `execute_command` tools). This is distinct from the customize-jupyterlab skill, which edits config files to change defaults; this skill drives the app that is already open and writes nothing to disk (rich content renders straight into a panel, no file needed).
compatibility: Requires xtralab (or ajlab / a JupyterLab with `jupyterlab-commands-toolkit` and `jupyter-server-mcp` installed), a JupyterLab tab open in a browser and connected to the server, and the `jupyter` MCP server configured in the agent. In xtralab these are wired by default. Rendering into a panel with `xtralab:show` needs no kernel; only the optional notebook fallback (for output you must compute by running code) needs a kernel.
---

# Guided code walkthrough

xtralab exposes the running JupyterLab frontend to coding agents through an MCP
command bridge. You can open files, move and highlight lines, lay widgets out
side by side, and render rich content into panels, all by sending the same
commands the UI itself dispatches. This turns a chat answer into a guided tour:
the user watches their editor open the right file, jump to the right line, and a
chart appear next to it.

The catch is scale. The frontend registers more than 480 commands, far too many
to scan each time. This skill gives you the ~25 that matter for walkthroughs,
with their verified argument shapes, so you act precisely instead of guessing.

## The command bridge

The `jupyter` MCP server (package `jupyter-server-mcp`, frontend bridge
`jupyterlab-commands-toolkit`) gives you exactly two tools:

- **`list_all_commands(query?)`** returns every registered command. Pass a
  `query` to filter by id, label, caption, or description (case-insensitive),
  for example `list_all_commands(query="console")`. The full list is large;
  always filter. Each entry has `id`, `label`, an optional `caption`, and `args`.
- **`execute_command(command_id, args?)`** runs one command and waits for the
  frontend's result, returning `{ success, result, error }`.

**`args` is a JSON Schema, not the arguments themselves.** The real parameter
names live under `args.properties`, and `args.required` lists the mandatory
ones. Pass arguments to `execute_command` as a plain object:
`execute_command("docmanager:open", { "path": "src/index.ts" })`.

Read **[references/commands.md](references/commands.md)** for the curated
catalog with each command's verified argument shape.

## What you can do

| Goal                              | Command                                                         | Notes                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open a file in the editor         | `docmanager:open` `{ path }`                                    | Opens with the right viewer. Add `options: { mode: "split-right" }` to place it beside the current tab.                                                                                        |
| Reveal a file in the file browser | `filebrowser:go-to-path` `{ path }`                             | Selects and scrolls to it without opening.                                                                                                                                                     |
| Move the cursor to a line         | `fileeditor:go-to-line` `{ line, column }`                      | 1-indexed. Scrolls and places the cursor; no lasting mark.                                                                                                                                     |
| **Highlight a range of lines**    | `xtralab:highlight-lines` `{ path?, line, endLine?, reveal? }`  | xtralab command. Opens the file if needed, scrolls, and paints a persistent overlay on the lines. Clear with `xtralab:clear-highlights`.                                                       |
| Highlight text matches            | `documentsearch:start` `{ searchText }`                         | Opens the find overlay and highlights every match. Clear with `documentsearch:end`.                                                                                                            |
| **Show rich content in a panel**  | `xtralab:show` `{ mimeType, data, label?, id?, mode? }`         | xtralab command. Renders Markdown (incl. Mermaid), a Vega-Lite chart, HTML, or an SVG/PNG into a side panel. No file, no kernel. See [references/rich-display.md](references/rich-display.md). |
| Show ad-hoc raw text/code         | `code-viewer:open` `{ content, label?, mimeType? }`             | Read-only viewer for a snippet, diff, or log. Shows raw text highlighted by `mimeType`; it does not render Markdown.                                                                           |
| Focus the layout                  | `application:set-mode` `{ mode: "single-document" }`            | Hides tabs and panels for a clean stage. `"multiple-document"` restores.                                                                                                                       |
| Toggle side panels                | `application:toggle-left-area`, `application:toggle-right-area` |                                                                                                                                                                                                |
| Switch theme                      | `apputils:change-theme` `{ theme }`                             | The value is the theme's registered display name, e.g. `"Pierre Dark"`, not the package id.                                                                                                    |

The two starred capabilities (line highlight, panel display) are the heart of a
walkthrough. Recipes that chain these into a full tour are in
**[references/recipes.md](references/recipes.md)**.

## Workflow

For any "show me / walk me through" request:

1. **Confirm the frontend is reachable.** Call `list_all_commands(query="docmanager:open")`. A normal result means a JupyterLab tab is connected. A timeout means no frontend is listening (see Gotchas); tell the user to open or focus their xtralab window, and stop.
2. **Plan the tour as a short sequence of commands**, narrating each step in chat as you run it ("Opening `src/index.ts`...", "Highlighting the plugin array..."). Keep the user oriented; the UI motion plus your words is the walkthrough.
3. **Open before you act.** Most commands operate on the _active_ widget. Open or activate the target first (`docmanager:open`), then navigate, highlight, or show.
4. **Highlight precisely.** Use `xtralab:highlight-lines` for a line range you read out of the source yourself (you have the file open as a coding agent, so you know the exact lines; do not trust remembered numbers, files drift). Clear with `xtralab:clear-highlights` before moving to an unrelated spot, or let the next highlight in the same file replace it.
5. **Show rich content with `xtralab:show`.** Generate the content yourself (a Vega-Lite spec for a chart, Markdown with a Mermaid block for a diagram, HTML for a table) and render it into a side panel. No notebook, no kernel. Only drop to authoring and running a notebook when the output must be _computed_ by running code; see [references/rich-display.md](references/rich-display.md).
6. **Clean up if asked.** Highlights clear with `xtralab:clear-highlights`; panels close like any tab. Delete any throwaway notebook you authored unless the user wants to keep it.

## Gotchas

These are verified behaviors of the bridge, not guesses:

- **A frontend must be connected.** Commands round-trip through the browser. With no JupyterLab tab open and connected to the server, every call fails with `"Command timed out after 10.0 seconds"`. This is the first thing to check.
- **`success` is the signal, not `result`.** Commands that return a widget or other non-JSON value come back as `{ success: true, result: "[Complex object - cannot serialize]" }`. Treat `success: true` as "it worked"; do not parse `result` for those.
- **Commands act on the active widget unless given a path.** Open or activate the target before you navigate or highlight, or you may act on whatever happens to be focused.
- **Highlights are for text and code editors.** `xtralab:highlight-lines` works in CodeMirror file editors. It does not highlight inside notebooks, terminals, or the settings editor; for those, narrate and use `code-viewer:open` or open the underlying source file.
- **Prefer `xtralab:show` over a kernel for visuals.** It renders Markdown, Vega-Lite, HTML, and images with no kernel. Reach for a notebook only when the result must be computed by running code, and note the shipped kernel is minimal (matplotlib/pandas are not guaranteed). Opening a `.ipynb` also pops a modal kernel dialog that blocks the bridge unless you pass a `kernelPreference`; [references/rich-display.md](references/rich-display.md) covers both.

## When to use this skill vs. customize-jupyterlab

- **This skill** drives the app that is already running, to _show_ the user something now. It writes nothing to disk (panels are ephemeral); only the optional notebook fallback creates a file.
- **customize-jupyterlab** changes JupyterLab's configuration and defaults (themes, disabled extensions, settings) by editing config files, which takes effect after a restart.

If the user says "show me", "walk me through", "open", "highlight", "plot", or
"visualize", you want this skill. If they say "change the default", "hide",
"disable", or "set up", you want customize-jupyterlab.

## References

- [references/commands.md](references/commands.md) - the curated command catalog with verified argument schemas, grouped by what they do, plus how to discover more with `list_all_commands`.
- [references/recipes.md](references/recipes.md) - copy-adaptable walkthrough sequences: open and highlight a region, an explainer or chart panel, and a full multi-stop tour.
- [references/rich-display.md](references/rich-display.md) - rendering rich content with `xtralab:show` (Markdown, Vega-Lite, HTML, images), which MIME types render, and the notebook fallback for kernel-computed output.
