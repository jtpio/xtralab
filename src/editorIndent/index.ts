import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  EditorExtensionRegistry,
  IEditorExtensionRegistry
} from '@jupyterlab/codemirror';
import { indentUnit } from '@codemirror/language';
import { Compartment, EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import detectIndent from 'detect-indent';

const PLUGIN_ID = 'xtralab:editor-indent';

/**
 * Mime types whose newly-created (or too-short-to-detect) files should default
 * to a 2-space indent. Matches Prettier's defaults for web languages; mime
 * types not listed here inherit whatever the user has set in JupyterLab.
 * Covers .ts/.tsx/.jsx/.js variants registered by `@jupyterlab/codemirror`.
 */
const FALLBACK_INDENT_BY_MIME: Record<string, number> = {
  'application/ecmascript': 2,
  'application/javascript': 2,
  'application/json': 2,
  'application/typescript': 2,
  'application/x-javascript': 2,
  'application/x-json': 2,
  'application/x-yaml': 2,
  'text/css': 2,
  'text/ecmascript': 2,
  'text/html': 2,
  'text/javascript': 2,
  'text/jsx': 2,
  'text/typescript-jsx': 2,
  'text/x-markdown': 2,
  'text/x-yaml': 2,
  'text/yaml': 2
};

interface IResolvedIndent {
  unit: string;
  width: number;
}

/**
 * Run `detect-indent` against the file's content and convert its result into
 * something we can hand to CodeMirror.
 */
function detectFromContent(text: string): IResolvedIndent | null {
  if (text.length === 0) {
    return null;
  }
  const result = detectIndent(text);
  if (!result.type || result.amount <= 0) {
    return null;
  }
  if (result.type === 'tab') {
    // detect-indent returns `\t` for `indent` in tab mode; use a 4-column tab
    // as the visual width, which is what most language servers assume.
    return { unit: '\t', width: 4 };
  }
  return { unit: result.indent, width: result.amount };
}

function resolveIndent(text: string, mimeType: string): IResolvedIndent | null {
  const detected = detectFromContent(text);
  if (detected) {
    return detected;
  }
  const fallback = FALLBACK_INDENT_BY_MIME[mimeType];
  if (fallback === undefined) {
    return null;
  }
  return { unit: ' '.repeat(fallback), width: fallback };
}

function buildExtension(resolved: IResolvedIndent): Extension {
  // `Prec.highest` keeps these values first in their respective facets so
  // they beat both `defaultConfig` and per-editor `editorConfig.indentUnit`,
  // both of which JupyterLab registers at default precedence.
  return Prec.highest([
    indentUnit.of(resolved.unit),
    EditorState.tabSize.of(resolved.width)
  ]);
}

/**
 * Sniff each opened document's leading whitespace and configure CodeMirror's
 * `indentUnit` / `tabSize` to match. JupyterLab only exposes a single global
 * indent setting, which means TypeScript files written with 4-space indent and
 * Python files written with 2-space indent both look wrong in the same editor;
 * detecting from the file's own content sidesteps that without forcing every
 * project to share the same convention.
 *
 * Detection runs at editor-construction time and again on the first content
 * change — that second pass exists because JupyterLab's collaborative document
 * loader can settle the file body into the shared model after the editor view
 * already exists, in which case the factory would otherwise have only seen an
 * empty string.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Detect each file’s indentation style from its contents and configure CodeMirror to match; new files fall back to a language-based default.',
  autoStart: true,
  requires: [IEditorExtensionRegistry],
  activate: (
    app: JupyterFrontEnd,
    registry: IEditorExtensionRegistry
  ): void => {
    registry.addExtension({
      name: 'xtralab:per-language-indent',
      factory: options => {
        const { model } = options;
        const slot = new Compartment();
        const initialResolved = resolveIndent(
          model.sharedModel.getSource(),
          model.mimeType
        );
        const initial = initialResolved ? buildExtension(initialResolved) : [];

        let settled = initialResolved !== null;

        const refreshPlugin = ViewPlugin.fromClass(
          class {
            disconnect: (() => void) | null = null;

            constructor(public view: EditorView) {
              if (settled) {
                return;
              }
              const handler = (): void => {
                if (settled) {
                  return;
                }
                const resolved = resolveIndent(
                  model.sharedModel.getSource(),
                  model.mimeType
                );
                if (!resolved) {
                  return;
                }
                settled = true;
                view.dispatch({
                  effects: slot.reconfigure(buildExtension(resolved))
                });
                if (this.disconnect) {
                  this.disconnect();
                  this.disconnect = null;
                }
              };
              model.sharedModel.changed.connect(handler);
              this.disconnect = () => {
                model.sharedModel.changed.disconnect(handler);
              };
            }

            destroy(): void {
              if (this.disconnect) {
                this.disconnect();
                this.disconnect = null;
              }
            }
          }
        );

        return EditorExtensionRegistry.createImmutableExtension([
          slot.of(initial),
          refreshPlugin
        ]);
      }
    });
  }
};

export default plugin;
