# Rich display: charts, diagrams, tables, explainers

To show the user something visual beside the code, render it into a panel with
the xtralab command **`xtralab:show`**. You generate the content yourself and
hand it over; JupyterLab renders it with the same renderers it uses for cell
output, but with no notebook file and no kernel.

## `xtralab:show`

```jsonc
execute_command("xtralab:show", {
  "mimeType": "application/vnd.vegalite.v5+json",
  "data": { /* a Vega-Lite spec object */ },
  "label": "Plugin count",
  "id": "chart",          // optional; calls sharing an id reuse one panel
  "mode": "split-right"   // optional; where to dock it (default split-right)
})
```

Arguments (also discoverable via `list_all_commands(query="xtralab:show")`):

- **`mimeType`** (required): what kind of content `data` is.
- **`data`** (required): the content. A string for text and image types (base64
  for `image/png`); an object for JSON types such as a Vega-Lite spec.
- `label`: the panel's tab title (default `"Output"`).
- `id`: a panel identifier. Repeated `xtralab:show` calls with the same `id`
  refresh that one panel in place instead of opening new tabs (default
  `"default"`). Use distinct ids to show several panels at once.
- `mode`: placement relative to the active tab: `split-right` (default),
  `split-left`, `split-bottom`, `split-top`, `tab-after`, `tab-before`.

It returns a short confirmation string, or an error if the MIME type has no
renderer.

## What renders

These were verified rendering through `xtralab:show` in a stock xtralab
frontend, with no kernel:

| `mimeType`                         | `data`                | Use it for                                                                                                                                              |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text/markdown`                    | Markdown string       | Explainers. Renders headings, code, lists, math, and **Mermaid** diagrams from a ` ```mermaid ` fenced block.                                           |
| `application/vnd.vegalite.v5+json` | Vega-Lite spec object | Interactive charts (bars, lines, scatter, ...) with tooltips, zoom, and an export menu. The best chart option: you emit a JSON spec, no library needed. |
| `text/html`                        | HTML string           | Arbitrary formatted content and simple tables. Scripts in the HTML are sanitized away, so use this for markup, not for JS widgets.                      |
| `image/svg+xml`                    | SVG string            | Vector diagrams you draw or generate.                                                                                                                   |
| `image/png`                        | base64 PNG string     | A raster image you already have.                                                                                                                        |

For a chart, prefer **Vega-Lite**: you write the spec as JSON (which a coding
agent does well), it renders interactively, and it needs nothing installed in
any kernel. For a flow/structure diagram, prefer **Mermaid inside a
`text/markdown` payload**. For prose with emphasis and code, use
`text/markdown`.

## Example: a chart of something you computed

The agent computes the value from the source it just read, then emits a
Vega-Lite spec. For example, to chart how many plugins `src/index.ts` registers,
count the array entries, **expanding any spread entries** (an entry like
`...gitPlugins` is itself an array of several plugins, so it counts as more than
one). Then:

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

## Example: an explainer with a diagram

````jsonc
execute_command("xtralab:show", {
  "mimeType": "text/markdown",
  "label": "How plugins load",
  "data": "# Plugin loading\n\n`src/index.ts` exports an **array**; JupyterLab activates each plugin independently.\n\n```mermaid\ngraph TD;\n  index[\"src/index.ts\"] --> arr[\"plugins array\"];\n  arr --> a[\"plugin A\"];\n  arr --> b[\"plugin B\"];\n```\n"
})
````

## When you actually need a kernel

`xtralab:show` covers showing content you can generate as text or a spec. If the
content has to be **computed by running code** (analyzing a real dataframe,
producing a matplotlib figure from live data), that needs a kernel, and the
path is to author a notebook and run it:

1. Write a small `.ipynb` to the **Jupyter server's root directory** (paths are
   resolved relative to the server root, not your shell's cwd).
2. Open it with a kernel preference so no dialog blocks the bridge:
   `docmanager:open` `{ "path": "tour.ipynb", "kernelPreference": { "name": "python3", "autoStartDefault": true, "shouldStart": true }, "options": { "mode": "split-right" } }`.
   With `shouldStart` + `autoStartDefault` the kernel attaches immediately, so
   calling `notebook:run-all-cells` right after is safe (execution queues until
   the kernel is ready).
3. `execute_command("notebook:run-all-cells")`.

Caveats that make this the fallback, not the default:

- The **shipped xtralab kernel is minimal** (only `ipykernel` and
  `matplotlib_inline`); matplotlib, pandas, numpy, and altair are **not**
  guaranteed to be installed. A chart attempt can fail with
  `ModuleNotFoundError`. Probe with a `try`/`except` import first, or install
  what you need from a terminal when the user agrees.
- matplotlib renders as a static `image/png`; **plotly and bokeh render nothing**
  unless their JupyterLab renderer extensions are installed.
- It leaves a notebook file on disk; delete it afterward unless the user wants
  to keep it.

Because of all this, reach for `xtralab:show` first. Drop to a notebook only
when you must run code to get the result.
