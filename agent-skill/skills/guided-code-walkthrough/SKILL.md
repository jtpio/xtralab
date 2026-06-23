---
name: guided-code-walkthrough
description: Use this skill when the user wants you to *show* them something inside the running xtralab (or JupyterLab) app rather than just describe it in chat: open a file in the editor, jump to and highlight specific lines, give a visual tour of the codebase, or render a chart, diagram, table, or explainer beside the code. Triggers include "walk me through", "show me where", "give me a tour", "open and highlight", "point at", "visualize this", "plot this", "draw a chart of", "explain this code visually", or any request to drive the live UI. The recommended way is to build a read-only Walkthrough panel in the side area (`xtralab:walkthrough`) so the explanation persists beside the code for the user to read at their own pace, instead of racing ahead in chat. Works by sending JupyterLab commands to the connected frontend over the MCP command bridge (the `jupyter` MCP server's `list_all_commands` and `execute_command` tools). This is distinct from the customize-jupyterlab skill, which edits config files to change defaults; this skill drives the app that is already open and writes nothing to disk.
compatibility: Requires xtralab (or ajlab / a JupyterLab with `jupyterlab-commands-toolkit` and `jupyter-server-mcp` installed), a JupyterLab tab open in a browser and connected to the server, and the `jupyter` MCP server configured in the agent. In xtralab these are wired by default. The Walkthrough panel and `xtralab:show` need no kernel; only the optional notebook fallback (for output you must compute by running code) needs one.
---

# Guided code walkthrough

xtralab exposes the running JupyterLab frontend to coding agents through an MCP
command bridge. You can open files, highlight lines, and render rich content
into side panels by sending the same commands the UI itself dispatches. This
turns a chat answer into a guided tour: the user watches their editor open the
right file and jump to the right line, with the explanation beside it.

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

## Prefer the Walkthrough panel

When the user asks you to walk them through something, **build it up in the
Walkthrough panel** with `xtralab:walkthrough` instead of narrating only in
chat. The panel is a read-only column in the side area that accumulates the
whole tour, so the user reads at their own pace and can scroll back; the agent's
chat can otherwise race ahead of what they are reading.

```jsonc
execute_command("xtralab:walkthrough", {
  "title": "1. The plugin array",
  "body": "`src/index.ts` exports an **array** of plugins. Each is activated independently.",
  "path": "src/index.ts",       // optional: opens it full-width and highlights
  "line": 30,
  "endLine": 48
})
```

Each step can carry:

- `title` and `body` (Markdown: prose, code snippets, lists, math, and Mermaid
  diagrams from a ` ```mermaid ` block).
- `path` + `line`/`endLine`: a code reference. Adding it opens the file
  **full-width in the editor (no split)** and highlights the lines, and the step
  keeps an "Open …" button so the user can jump back later.
- `media`: an embedded visual, `{ mimeType, data }` (e.g. a Vega-Lite spec).
- `reset: true` to clear the panel and start a fresh tour (use it on step 1).

So a tour is a sequence of `xtralab:walkthrough` calls. Narrate briefly in chat
too, but the panel is the durable artifact the user follows.

## What you can do

| Goal                                  | Command                                                                           | Notes                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Build a guided tour (recommended)** | `xtralab:walkthrough` `{ title?, body?, path?, line?, endLine?, media?, reset? }` | xtralab command. Appends a step to the read-only side panel; a step with a path opens the file full-width and highlights it.         |
| Open a file in the editor             | `docmanager:open` `{ path }`                                                      | Opens full-width with the right viewer.                                                                                              |
| **Highlight a range of lines**        | `xtralab:highlight-lines` `{ path?, line, endLine?, reveal? }`                    | xtralab command. Opens the file if needed, scrolls, and paints a persistent overlay. Clear with `xtralab:clear-highlights`.          |
| Highlight text matches                | `documentsearch:start` `{ searchText }`                                           | Opens the find overlay and highlights every match. Clear with `documentsearch:end`.                                                  |
| Show a standalone panel               | `xtralab:show` `{ mimeType, data, label?, id? }`                                  | xtralab command. Renders Markdown/Vega-Lite/HTML/image into a side panel (defaults to the side area, so it never splits the editor). |
| Show ad-hoc raw text/code             | `code-viewer:open` `{ content, label?, mimeType? }`                               | Read-only viewer for a snippet, diff, or log. Raw text only; does not render Markdown.                                               |
| Focus the layout                      | `application:set-mode` `{ mode: "single-document" }`                              | Hides tabs and side panels for a clean stage. `"multiple-document"` restores.                                                        |
| Switch theme                          | `apputils:change-theme` `{ theme }`                                               | The value is the theme's registered display name, e.g. `"Pierre Dark"`, not the package id.                                          |

## Workflow

For any "show me / walk me through" request:

1. **Confirm the frontend is reachable.** Call `list_all_commands(query="docmanager:open")`. A normal result means a JupyterLab tab is connected. A timeout means no frontend is listening (see Gotchas); tell the user to open or focus their xtralab window, and stop.
2. **Start the tour:** `xtralab:walkthrough` with `reset: true` and your first step.
3. **Add a step per stop.** Read the real line numbers out of the file yourself (you have it open as a coding agent; do not trust remembered numbers, code drifts). Give each stop a `title`, a short `body`, and the `path`/`line`/`endLine` it is about; the editor follows along full-width and highlights, and the step is saved with a jump-back button.
4. **Embed visuals where they help** by passing `media` (a Vega-Lite chart, an SVG diagram) on a step, or a Mermaid block inside `body`.
5. **Keep chat narration light.** A one-line "here's the tour →" plus the panel is enough; the durable explanation lives in the panel.
6. **Clean up if asked.** `xtralab:clear-highlights` removes highlights; the panel and any `xtralab:show` panels close like any tab.

## Gotchas

These are verified behaviors of the bridge, not guesses:

- **A frontend must be connected.** Commands round-trip through the browser. With no JupyterLab tab open and connected to the server, every call fails with `"Command timed out after 10.0 seconds"`. This is the first thing to check.
- **`success` is the signal, not `result`.** Commands that return a widget or other non-JSON value come back as `{ success: true, result: "[Complex object - cannot serialize]" }`. Treat `success: true` as "it worked"; do not parse `result` for those.
- **Rich content goes to the side, files stay full-width.** The Walkthrough panel and `xtralab:show` dock in the side area, so opening files never splits the editor. Pass `area: "main"` to `xtralab:show` only if you deliberately want a document-area split.
- **Commands act on the active widget unless given a path.** Open or activate the target before you navigate or highlight.
- **Highlights are for text and code editors.** `xtralab:highlight-lines` works in CodeMirror file editors, not notebooks, terminals, or the settings editor.
- **Prefer rendering over a kernel for visuals.** The Walkthrough panel and `xtralab:show` render Markdown, Vega-Lite, HTML, and images with no kernel. Reach for a notebook only when the result must be computed by running code, and note the shipped kernel is minimal (matplotlib/pandas not guaranteed); see [references/rich-display.md](references/rich-display.md).

## When to use this skill vs. customize-jupyterlab

- **This skill** drives the app that is already running, to _show_ the user something now. It writes nothing to disk (panels are ephemeral); only the optional notebook fallback creates a file.
- **customize-jupyterlab** changes JupyterLab's configuration and defaults (themes, disabled extensions, settings) by editing config files, which takes effect after a restart.

If the user says "show me", "walk me through", "open", "highlight", "plot", or
"visualize", you want this skill. If they say "change the default", "hide",
"disable", or "set up", you want customize-jupyterlab.

## References

- [references/commands.md](references/commands.md) - the curated command catalog with verified argument schemas, grouped by what they do, plus how to discover more with `list_all_commands`.
- [references/recipes.md](references/recipes.md) - copy-adaptable walkthrough sequences built on `xtralab:walkthrough`, plus the lower-level highlight and panel moves.
- [references/rich-display.md](references/rich-display.md) - rendering rich content (Markdown, Vega-Lite, HTML, images) with no kernel, embedding it in walkthrough steps or `xtralab:show`, and the notebook fallback for computed output.
