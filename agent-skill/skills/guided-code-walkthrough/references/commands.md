# Curated command catalog

The frontend registers 480+ commands. This is the subset worth knowing for
guided walkthroughs, grouped by purpose. Argument names and shapes here were
read from the live frontend's `args.properties`; pass them to
`execute_command` as a plain object.

When in doubt about a command not listed here, discover it with
`list_all_commands(query="...")` and read its `args.properties` (see the bottom
of this file).

## How to read an argument list

`list_all_commands` returns, per command, an `args` value that is a JSON
Schema. The usable parameters are the keys of `args.properties`; `args.required`
lists the mandatory ones. Example for `docmanager:open`:

```jsonc
{
  "id": "docmanager:open",
  "args": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "The path of the file to open"
      },
      "options": {
        "type": "object",
        "description": "...",
        "properties": {
          "mode": { "type": "string" },
          "activate": { "type": "boolean" },
          "ref": { "type": "string" }
        }
      },
      "kernelPreference": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "autoStartDefault": { "type": "boolean" },
          "shouldStart": { "type": "boolean" }
        }
      }
    }
  }
}
```

So you call `execute_command("docmanager:open", { "path": "src/index.ts" })`.

## Open and reveal

| Command                       | Key args (required in **bold**)                                                          | What it does                                                                                                                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docmanager:open`             | `path`, `options` ({ `mode`, `activate`, `ref`, `rank` }), `kernelPreference`, `factory` | Open a file in its default viewer. `options.mode` accepts `"split-right"`, `"split-left"`, `"split-bottom"`, `"split-top"`, `"tab-after"`, `"tab-before"` to place it relative to the current tab. For notebooks, pass `kernelPreference` (below) to avoid the kernel dialog. |
| `docmanager:open-browser-tab` | **`path`**                                                                               | Open the file in a new browser tab.                                                                                                                                                                                                                                           |
| `filebrowser:go-to-path`      | `path`, `dontShowBrowser`                                                                | Reveal and select a file or folder in the file browser without opening it.                                                                                                                                                                                                    |
| `filebrowser:open-path`       | `path`, `dontShowBrowser`                                                                | Open a path via the file browser (prompts if `path` omitted).                                                                                                                                                                                                                 |
| `markdownviewer:open`         | **`path`**, `options`                                                                    | Open a _rendered_ Markdown preview. Needs a file on disk.                                                                                                                                                                                                                     |
| `code-viewer:open`            | **`content`**, `label`, `mimeType`, `extension`                                          | Open a read-only viewer holding arbitrary `content`, with no backing file. Good for a snippet, a diff, a log, or generated notes. It shows the raw text syntax-highlighted by `mimeType` (e.g. `"text/x-python"`); it does **not** render Markdown to HTML.                   |

`docmanager:open` and most other open commands return the new widget, which is
not serializable, so expect `result: "[Complex object - cannot serialize]"`
with `success: true`.

### Opening a notebook with a kernel, no dialog

```jsonc
execute_command("docmanager:open", {
  "path": "tour.ipynb",
  "kernelPreference": { "name": "python3", "autoStartDefault": true, "shouldStart": true },
  "options": { "mode": "split-right" }
})
```

This opens `tour.ipynb` to the right of the active tab and starts the Python
kernel immediately, so no "Select Kernel" modal appears to block later commands.

## Navigate and highlight

| Command                                                             | Key args                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fileeditor:go-to-line`                                             | `line`, `column`                    | Move the cursor to a 1-indexed position in the active text editor and scroll to it. Leaves no lasting mark.                                                                                                                                                                                                                                                                                                                    |
| `xtralab:highlight-lines`                                           | `path`, `line`, `endLine`, `reveal` | **xtralab command.** Paint a persistent overlay across a line range. Opens `path` if it is not already open (omit `path` to use the active editor), highlights `line` through `endLine` (1-indexed, inclusive; `endLine` defaults to `line` for a single line), and scrolls the range into view unless `reveal` is `false`. A new highlight in the same editor replaces the previous one. Returns a short confirmation string. |
| `xtralab:clear-highlights`                                          | (none)                              | **xtralab command.** Remove every highlight painted by `xtralab:highlight-lines`.                                                                                                                                                                                                                                                                                                                                              |
| `documentsearch:start`                                              | `searchText`                        | Open the find overlay and highlight every match of `searchText` in the active document. Use when you want to mark all occurrences of a token rather than a contiguous range.                                                                                                                                                                                                                                                   |
| `documentsearch:highlightNext` / `documentsearch:highlightPrevious` | (none)                              | Step the active match through the highlighted hits.                                                                                                                                                                                                                                                                                                                                                                            |
| `documentsearch:end`                                                | (none)                              | Close the find overlay and clear its highlights.                                                                                                                                                                                                                                                                                                                                                                               |

**Choosing a highlight:** use `xtralab:highlight-lines` for "look at this block"
(a function body, an import group, an array literal) since you know the exact
line numbers from reading the file. Use `documentsearch:start` for "every place
this symbol appears". They are independent; clear each with its own command
(`xtralab:clear-highlights` and `documentsearch:end`).

## Show rich content

The primary way to show a chart, diagram, table, or explainer is `xtralab:show`:
you generate the content and it renders into a panel with no file and no kernel.
See [rich-display.md](rich-display.md) for the full treatment and the MIME types
that render.

| Command        | Key args (required in **bold**)                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xtralab:show` | **`mimeType`**, **`data`**, `label`, `id`, `mode` | **xtralab command.** Render one MIME bundle into a main-area panel. `mimeType` is e.g. `"text/markdown"` (Markdown, including Mermaid), `"application/vnd.vegalite.v5+json"` (interactive chart), `"text/html"`, `"image/svg+xml"`, `"image/png"`. `data` is a string for text/image types (base64 for PNG) or an object for JSON specs. Calls sharing an `id` reuse one panel; `mode` places it (default `"split-right"`). |

### Running code for computed output (fallback)

Only when the result must be _computed_ by running code (analyzing a live
dataframe, plotting from real data) do you author a notebook and run it. The
shipped kernel is minimal, so plotting/data libraries are not guaranteed; see
[rich-display.md](rich-display.md).

| Command                    | Key args                                       | What it does                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notebook:run-all-cells`   | (none)                                         | Run every cell of the active notebook. Succeeds only when a kernel is attached.                                                                                                                    |
| `notebook:run-cell`        | (none)                                         | Run the active cell.                                                                                                                                                                               |
| `notebook:restart-run-all` | (none)                                         | Restart the kernel and run all cells (may prompt to confirm the restart).                                                                                                                          |
| `notebook:create-new`      | `cwd`, `kernelName`                            | Create a new empty notebook. Passing `kernelName: "python3"` attaches a kernel.                                                                                                                    |
| `console:create`           | `kernelPreference`, `cwd`, `ref`, `insertMode` | Open a console (a REPL widget) with a kernel.                                                                                                                                                      |
| `console:inject`           | **`path`**, **`code`**                         | Run `code` in the console session identified by `path`. The `path` is the console session's path; `console:create` does not return it, so a notebook is usually easier to drive deterministically. |

## Layout and framing the stage

| Command                                                          | Key args    | What it does                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application:set-mode`                                           | **`mode`**  | `"single-document"` hides tabs and side panels for a focused stage; `"multiple-document"` restores the normal layout.                                                                        |
| `application:toggle-left-area` / `application:toggle-right-area` | (none)      | Show or hide a side panel.                                                                                                                                                                   |
| `application:toggle-side-tabbar`                                 | **`side`**  | Show or hide a sidebar's tab strip.                                                                                                                                                          |
| `filebrowser:activate`                                           | `path`      | Focus the file browser (and optionally a path).                                                                                                                                              |
| `apputils:change-theme`                                          | **`theme`** | Switch theme. The value is the theme's registered _display name_ (as shown in Settings > Theme), e.g. `"Pierre Dark"` / `"Pierre Light"`, not the package id. Names vary by installed theme. |

## Discovering more

Anything not listed here is one `list_all_commands` call away:

```jsonc
// What commands touch the notebook?
list_all_commands(query="notebook")

// Exactly how do I call this one?
list_all_commands(query="docmanager:open")  // then read result.commands[0].args.properties
```

Filtering by namespace prefix is the fastest way to find a capability you
suspect exists: the big ones are `notebook`, `filebrowser`, `git`, `fileeditor`,
`application`, `apputils`, `console`, `docmanager`, and `xtralab`.
