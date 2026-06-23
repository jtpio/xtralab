import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import type { ReadonlyPartialJSONValue } from '@lumino/coreutils';
import { Panel } from '@lumino/widgets';

const PLUGIN_ID = 'xtralab:show-output';

/** Render arbitrary rich content into a panel, with no notebook and no kernel. */
const SHOW_COMMAND = 'xtralab:show';

/**
 * Parse a JSON-typed value that may have arrived as a string. Agents and the
 * MCP bridge sometimes serialize a spec (e.g. a Vega-Lite object) to a string;
 * for `application/...json` MIME types we accept either and parse the string.
 */
function coerceData(
  mimeType: string,
  data: ReadonlyPartialJSONValue
): ReadonlyPartialJSONValue {
  if (typeof data === 'string' && /\+?json$/.test(mimeType)) {
    try {
      return JSON.parse(data) as ReadonlyPartialJSONValue;
    } catch {
      return data;
    }
  }
  return data;
}

/**
 * Contribute `xtralab:show`: render a single MIME bundle into a main-area
 * panel using the application's render-mime registry.
 *
 * This is the kernel-free counterpart to running a notebook. A coding agent
 * generates the content itself (a Vega-Lite spec, a Markdown explainer, an
 * HTML fragment, an SVG, a base64 image) and hands it to this command, which
 * renders it with the same renderers JupyterLab uses for cell output and docks
 * the result beside the code. Nothing is written to disk and no kernel is
 * required, so it works even where the kernel has no plotting libraries.
 *
 * Repeated calls with the same `id` reuse one panel, so a walkthrough can
 * refresh the view in place instead of piling up tabs.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Render rich content (Markdown, Vega-Lite, HTML, images) into a panel.',
  autoStart: true,
  requires: [IRenderMimeRegistry, ILabShell],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    rendermime: IRenderMimeRegistry,
    labShell: ILabShell,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ): void => {
    const { commands } = app;
    const trans = (translator ?? nullTranslator).load('jupyterlab');

    // One reusable panel per `id`, so repeated shows refresh in place.
    const panels = new Map<string, Panel>();

    commands.addCommand(SHOW_COMMAND, {
      label: trans.__('Show Rich Output'),
      caption: trans.__(
        'Render Markdown, a Vega-Lite chart, HTML, or an image in a panel'
      ),
      describedBy: {
        args: {
          type: 'object',
          required: ['mimeType', 'data'],
          properties: {
            mimeType: {
              type: 'string',
              description:
                'MIME type to render, e.g. "text/markdown", "application/vnd.vegalite.v5+json", "text/html", "image/svg+xml", "image/png".'
            },
            data: {
              description:
                'The content. A string for text/image types (base64 for "image/png"); an object for JSON types such as a Vega-Lite spec.'
            },
            label: {
              type: 'string',
              description: 'Title for the panel tab. Defaults to "Output".'
            },
            id: {
              type: 'string',
              description:
                'Panel identifier. Calls sharing an `id` reuse one panel; defaults to "default".'
            },
            area: {
              type: 'string',
              description:
                'Where the panel docks: "right" (default) puts it in the side area so the editor stays full width; "main" puts it in the document area (split with `mode`).'
            },
            mode: {
              type: 'string',
              description:
                'Only when `area` is "main": placement relative to the active tab, e.g. "split-right" (default), "split-bottom", "tab-after".'
            }
          }
        }
      },
      execute: async args => {
        const mimeType =
          typeof args['mimeType'] === 'string' ? args['mimeType'] : undefined;
        if (!mimeType || args['data'] === undefined) {
          throw new Error('xtralab:show requires "mimeType" and "data"');
        }
        const data = coerceData(mimeType, args['data']);
        const label =
          typeof args['label'] === 'string'
            ? args['label']
            : trans.__('Output');
        const id = typeof args['id'] === 'string' ? args['id'] : 'default';
        const area = args['area'] === 'main' ? 'main' : 'right';
        const mode =
          typeof args['mode'] === 'string' ? args['mode'] : 'split-right';

        const bundle = { [mimeType]: data };
        const chosen = rendermime.preferredMimeType(bundle, 'any');
        if (!chosen) {
          throw new Error(
            `xtralab:show: no renderer for MIME type "${mimeType}"`
          );
        }

        const model = rendermime.createModel({ data: bundle, trusted: true });
        const renderer = rendermime.createRenderer(chosen);
        // A scrollable Panel, not a MainAreaWidget: MainAreaWidget does not lay
        // out its content in the side area, and the panel needs to scroll when
        // the content is taller than it (style/showOutput.css).
        const widget = new Panel();
        widget.addClass('jp-xtralab-ShowPanel');
        widget.id = `xtralab-show-${id}`;
        widget.title.label = label;
        widget.title.closable = true;
        widget.addWidget(renderer);

        // Replace any existing panel with this id so shows refresh in place.
        const existing = panels.get(id);
        if (existing && !existing.isDisposed) {
          existing.dispose();
        }
        panels.set(id, widget);
        widget.disposed.connect(() => {
          if (panels.get(id) === widget) {
            panels.delete(id);
          }
        });

        // Attach before rendering so renderers that need layout (Vega) size
        // correctly. Default to the side area so the editor keeps full width;
        // only split the document area when `area` is "main".
        if (area === 'main') {
          labShell.add(widget, 'main', {
            mode: mode as DocumentMode,
            activate: true
          });
        } else {
          labShell.add(widget, 'right', { rank: 900 });
        }
        // Reveal the panel (the side area does not open from `add` alone).
        labShell.activateById(widget.id);

        try {
          await renderer.renderModel(model);
        } catch (error) {
          widget.dispose();
          throw error instanceof Error
            ? error
            : new Error(`xtralab:show: failed to render "${mimeType}"`);
        }
        return trans.__('Rendered %1 in "%2"', mimeType, label);
      }
    });

    if (palette) {
      palette.addItem({ command: SHOW_COMMAND, category: trans.__('Other') });
    }
  }
};

type DocumentMode =
  | 'split-top'
  | 'split-left'
  | 'split-right'
  | 'split-bottom'
  | 'tab-before'
  | 'tab-after';

export default plugin;
