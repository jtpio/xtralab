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
 * 2-space fallback for new or undetectable files, matching Prettier's
 * web-language defaults; unlisted mime types keep the user's setting.
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

/**
 * The indentation resolved for a document.
 */
interface IResolvedIndent {
  /**
   * The string inserted per indent level (spaces or a tab), for `indentUnit`.
   */
  unit: string;
  /**
   * The indent width in columns, for `EditorState.tabSize`.
   */
  width: number;
}

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
  // `Prec.highest` beats both `defaultConfig` and per-editor
  // `editorConfig.indentUnit`, which JupyterLab registers at default precedence.
  return Prec.highest([
    indentUnit.of(resolved.unit),
    EditorState.tabSize.of(resolved.width)
  ]);
}

/**
 * Sniff each document's indentation and configure CodeMirror's `indentUnit` /
 * `tabSize` to match, since JupyterLab only has one global indent setting.
 * Detection reruns on the first content change: the collaborative loader can
 * settle the file body after the editor view exists, so the factory may see ''.
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
