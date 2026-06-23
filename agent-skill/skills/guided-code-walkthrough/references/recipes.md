# Walkthrough recipes

Concrete sequences you can adapt. Each is a list of `execute_command` calls.
Narrate each step in chat as you run it so the user follows the UI motion. All
command ids and arguments match the [catalog](commands.md).

Two house rules run through every recipe: **commands act on the active widget**,
so open or activate the target first; and **line numbers are illustrative**, so
read the real ones out of the file you have open rather than trusting any number
written here or remembered, since source drifts.

## 1. Open a file and highlight a region

The bread-and-butter move: "let me show you where X is". Say you read the file
and the block you want to point at spans lines 30 to 46:

```jsonc
// Opens the file if needed and scrolls the range into view.
execute_command("xtralab:highlight-lines", {
  "path": "src/index.ts",
  "line": 30,
  "endLine": 46
})
```

`xtralab:highlight-lines` opens the file if it is not already open, so this one
call is often the whole step. If the file is already the active editor you can
omit `path`. When you move to an unrelated spot, either let the next
`xtralab:highlight-lines` in the same file replace the mark, or clear it:

```jsonc
execute_command("xtralab:clear-highlights")
```

To point at a single line, pass just `line` (e.g. the one line you want):

```jsonc
execute_command("xtralab:highlight-lines", { "path": "src/index.ts", "line": 30 })
```

## 2. A multi-stop guided tour

Walk through several files, pausing on each. Narrate between steps. The line
numbers below are placeholders; read each block's real range from the file
before you call.

```jsonc
// Stop 1: the entry point (e.g. the plugin array in src/index.ts).
execute_command("xtralab:highlight-lines", { "path": "src/index.ts", "line": 30, "endLine": 46 })
// (narrate: "Everything starts here, an array of plugins...")

// Stop 2: one plugin's implementation.
execute_command("xtralab:highlight-lines", { "path": "src/commandBar/index.ts", "line": 121, "endLine": 163 })
// (narrate: "commandBarPlugin adds the search pill to the top bar...")

// Stop 3: a related token.
execute_command("xtralab:highlight-lines", { "path": "src/omnibox/tokens.ts", "line": 1, "endLine": 20 })

// Done: clear the last highlight.
execute_command("xtralab:clear-highlights")
```

Each `xtralab:highlight-lines` switches the active editor to that file and
scrolls, so the tour drives itself.

Optionally set a focused stage at the start and restore it at the end:

```jsonc
execute_command("application:set-mode", { "mode": "single-document" })  // start
// ... tour ...
execute_command("application:set-mode", { "mode": "multiple-document" }) // end
```

## 3. Highlight every occurrence of a symbol

When the point is "this name shows up all over", use the find overlay instead of
a line range.

```jsonc
execute_command("docmanager:open", { "path": "src/index.ts" })
execute_command("documentsearch:start", { "searchText": "Plugin" })
// step through matches if you like:
execute_command("documentsearch:highlightNext")
// clear when done:
execute_command("documentsearch:end")
```

## 4. An explainer panel beside the code

Render a short, formatted explanation (with a diagram, if it helps) into a panel.
`xtralab:show` with `text/markdown` renders the Markdown, including a Mermaid
diagram from a fenced block, with no file and no kernel.

````jsonc
execute_command("xtralab:show", {
  "mimeType": "text/markdown",
  "label": "How plugins load",
  "data": "# Plugin loading\n\n`src/index.ts` exports an **array**; JupyterLab activates each plugin independently.\n\n```mermaid\ngraph TD;\n  index[\"src/index.ts\"] --> arr[\"plugins array\"];\n  arr --> a[\"plugin A\"];\n  arr --> b[\"plugin B\"];\n```\n"
})
````

For a raw, syntax-highlighted snippet (not rendered Markdown), use
`code-viewer:open` `{ content, label, mimeType: "text/x-python" }` instead.

## 5. A chart beside the code

Render data or structure as a chart, docked beside the source, with `xtralab:show`
and a Vega-Lite spec. No notebook, no kernel.

When the chart is _about_ the code (say, how many plugins a file registers),
compute the number from the source you just read, and **resolve spreads**: an
array entry like `...gitPlugins` is itself an array of several plugins, so it
counts as more than one. Then render:

```jsonc
execute_command("xtralab:show", {
  "mimeType": "application/vnd.vegalite.v5+json",
  "label": "Plugins by kind",
  "data": {
    "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
    "data": { "values": [
      { "kind": "editor", "n": 5 },
      { "kind": "git", "n": 4 },
      { "kind": "agent", "n": 3 }
    ] },
    "mark": "bar",
    "encoding": {
      "x": { "field": "kind", "type": "nominal" },
      "y": { "field": "n", "type": "quantitative" }
    }
  }
})
```

Full renderer details (and the notebook fallback for output you must compute by
running code) are in [rich-display.md](rich-display.md).

## 6. Full tour: narrate, highlight, and visualize

Combine the pieces for a complete "walk me through this module" answer:

1. `application:set-mode` `{ "mode": "single-document" }` to clear the stage.
2. `xtralab:highlight-lines` on the entry point; narrate.
3. `xtralab:highlight-lines` on each subsequent stop; narrate between them.
4. `xtralab:show` a panel that summarizes what you walked through: a Markdown
   explainer with a Mermaid data-flow diagram, or a Vega-Lite chart of a figure
   you computed from the source.
5. `xtralab:clear-highlights` and `application:set-mode` `{ "mode": "multiple-document" }` to restore.

Keep the chat narration in step with the UI: the user is watching their own
editor move, and your words are the voice-over.

## Before you start any recipe

Confirm a frontend is connected with a cheap probe:

```jsonc
list_all_commands(query="docmanager:open")
```

A normal result means a JupyterLab tab is connected and the recipes will work.
A `"Command timed out after 10.0 seconds"` error means no frontend is listening:
ask the user to open or focus their xtralab window, then retry.
