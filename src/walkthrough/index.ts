import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { tocIcon } from '@jupyterlab/ui-components';

import { IWalkthroughMedia, IWalkthroughStep, WalkthroughPanel } from './panel';

const PLUGIN_ID = 'xtralab:walkthrough';

/** Append a step to the read-only walkthrough panel. */
const WALKTHROUGH_COMMAND = 'xtralab:walkthrough';

const HIGHLIGHT_LINES_COMMAND = 'xtralab:highlight-lines';

const PANEL_ID = 'xtralab-walkthrough';

/** Pull a `{ mimeType, data }` media object out of a JSON command argument. */
function readMedia(value: unknown): IWalkthroughMedia | undefined {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { mimeType?: unknown }).mimeType === 'string'
  ) {
    const media = value as { mimeType: string; data?: unknown };
    return { mimeType: media.mimeType, data: media.data as never };
  }
  return undefined;
}

function toLine(value: unknown): number | undefined {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/**
 * Contribute `xtralab:walkthrough`: build a persistent, read-only walkthrough
 * in the right side area instead of narrating only in the agent's chat.
 *
 * Each call appends a step (Markdown prose, an optional embedded visual, and an
 * optional code reference). When a step names a file, the editor follows along
 * (opening it full-width in the main area, no split) and its lines are
 * highlighted; the step also keeps a button so the user can jump back to it
 * later. The panel accumulates the whole tour beside the code, so the user can
 * read at their own pace rather than chasing the chat.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Build a read-only guided walkthrough in the side panel.',
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

    let panel: WalkthroughPanel | null = null;

    const ensurePanel = (): WalkthroughPanel => {
      if (!panel || panel.isDisposed) {
        panel = new WalkthroughPanel({ rendermime, commands, trans });
        panel.id = PANEL_ID;
        panel.title.icon = tocIcon;
        panel.title.caption = trans.__('Walkthrough');
        labShell.add(panel, 'right', { rank: 1000, type: 'Walkthrough' });
        const created = panel;
        created.disposed.connect(() => {
          if (panel === created) {
            panel = null;
          }
        });
      }
      return panel;
    };

    commands.addCommand(WALKTHROUGH_COMMAND, {
      label: trans.__('Add Walkthrough Step'),
      caption: trans.__('Append a step to the read-only walkthrough panel'),
      describedBy: {
        args: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Optional heading for the step.'
            },
            body: {
              type: 'string',
              description:
                'Markdown for the step. Renders code snippets, lists, math, and Mermaid diagrams from a ```mermaid fenced block.'
            },
            path: {
              type: 'string',
              description:
                'Optional file the step is about, relative to the server root. The editor opens it (full width, no split) and highlights the lines, and the step keeps a button to jump back.'
            },
            line: {
              type: 'number',
              description: 'First line to highlight (1-indexed).'
            },
            endLine: {
              type: 'number',
              description: 'Last line to highlight (1-indexed, inclusive).'
            },
            media: {
              type: 'object',
              description:
                'Optional embedded visual, e.g. { "mimeType": "application/vnd.vegalite.v5+json", "data": <spec> }.',
              properties: {
                mimeType: { type: 'string' },
                data: {}
              },
              required: ['mimeType', 'data']
            },
            reveal: {
              type: 'boolean',
              description:
                'Whether to navigate and highlight the code as the step is added. Defaults to true.'
            },
            reset: {
              type: 'boolean',
              description:
                'Clear the existing walkthrough before adding this step (start a new tour).'
            }
          }
        }
      },
      execute: async args => {
        const current = ensurePanel();
        if (args['reset'] === true) {
          current.clear();
        }

        const path =
          typeof args['path'] === 'string' ? args['path'] : undefined;
        const line = toLine(args['line']);
        const endLine = toLine(args['endLine']);
        const media = readMedia(args['media']);
        const step: IWalkthroughStep = {
          title: typeof args['title'] === 'string' ? args['title'] : undefined,
          body: typeof args['body'] === 'string' ? args['body'] : undefined,
          media,
          path,
          line,
          endLine
        };

        if (
          !step.title &&
          !step.body &&
          !step.media &&
          !step.path &&
          args['reset'] !== true
        ) {
          throw new Error(
            'xtralab:walkthrough needs at least one of: title, body, media, path'
          );
        }

        // Reveal the panel, then render the step into it.
        labShell.activateById(current.id);
        await current.addStep(step);

        // Let the editor follow the newest step.
        if (path && args['reveal'] !== false) {
          await commands.execute(HIGHLIGHT_LINES_COMMAND, {
            path,
            line,
            endLine
          });
        }

        return trans.__('Added walkthrough step');
      }
    });

    if (palette) {
      palette.addItem({
        command: WALKTHROUGH_COMMAND,
        category: trans.__('Other')
      });
    }
  }
};

export default plugin;
