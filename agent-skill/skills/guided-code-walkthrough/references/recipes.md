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

## 2. A guided tour in the Walkthrough panel (recommended)

For "walk me through ...", build the tour up in the side panel with
`xtralab:walkthrough` so it persists for the user to read at their own pace.
Each step's `path`/`line`/`endLine` opens the file full-width and highlights it;
the line numbers below are placeholders, so read each block's real range from
the file first.

````jsonc
// Step 1: reset clears any prior tour. The editor opens src/index.ts and
// highlights the array; the step shows prose + an "Open src/index.ts:30" button.
execute_command("xtralab:walkthrough", {
  "reset": true,
  "title": "1. The plugin array",
  "body": "`src/index.ts` exports an **array** of plugins, each activated independently.",
  "path": "src/index.ts", "line": 30, "endLine": 46
})

// Step 2: the editor follows to the next file and highlights it.
execute_command("xtralab:walkthrough", {
  "title": "2. The command bar",
  "body": "`commandBarPlugin` adds the search pill to the top bar.",
  "path": "src/commandBar/index.ts", "line": 121, "endLine": 163
})

// Step 3: a step can be pure prose + an embedded diagram, with no code target.
execute_command("xtralab:walkthrough", {
  "title": "3. How they connect",
  "body": "The bar opens the omnibox:\n\n```mermaid\ngraph LR; bar-->omnibox-->agent;\n```"
})
````

The panel accumulates all three steps; the user can scroll back and click any
"Open …" button to revisit that spot. Narrate a single "here's the tour →" in
chat rather than repeating the whole thing.

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
Inside a tour, pass the same Markdown as a `xtralab:walkthrough` step's `body`
so it joins the rest of the walkthrough; reach for `xtralab:show` for a one-off
panel outside a tour.

## 5. A chart beside the code

Render data or structure as a chart with a Vega-Lite spec. No notebook, no
kernel. Inside a tour, pass the spec as a step's `media`
(`{ "mimeType": "application/vnd.vegalite.v5+json", "data": <spec> }`); for a
standalone chart use `xtralab:show` as below.

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

## 6. Full tour: one panel, narrated and visualized

The complete "walk me through this module" answer is recipe 2 with a closing
summary step. Build it entirely in the Walkthrough panel:

1. `xtralab:walkthrough` with `reset: true` and step 1 (the entry point, with its
   `path`/`line`/`endLine`).
2. A `xtralab:walkthrough` step per stop, each with a `body` and the code it is
   about, so the editor follows full-width and highlights.
3. A closing `xtralab:walkthrough` step that summarizes: a `body` with a Mermaid
   data-flow diagram, or a `media` Vega-Lite chart of a figure you computed from
   the source.
4. Optionally bracket the tour with `application:set-mode`
   `{ "mode": "single-document" }` at the start and `"multiple-document"` at the
   end for a focused stage.

The whole tour now lives in one read-only panel beside the code, so a one-line
"here's the walkthrough →" in chat is all the narration you need.

## Before you start any recipe

Confirm a frontend is connected with a cheap probe:

```jsonc
list_all_commands(query="docmanager:open")
```

A normal result means a JupyterLab tab is connected and the recipes will work.
A `"Command timed out after 10.0 seconds"` error means no frontend is listening:
ask the user to open or focus their xtralab window, then retry.
