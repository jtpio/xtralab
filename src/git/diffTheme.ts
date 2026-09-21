import {
  createCSSVariablesTheme,
  formatCSSVariablePrefix,
  registerCustomTheme,
  type DiffsThemeNames
} from '@pierre/diffs';

/**
 * Token colors for the JupyterLab Shiki themes. The values are CSS
 * variables, so theme changes recolor the diff.
 */
const JUPYTERLAB_THEME_VARIABLES: Record<string, string> = {
  foreground: 'var(--jp-content-font-color1)',
  background: 'var(--jp-layout-color1)',
  'token-keyword': 'var(--jp-mirror-editor-keyword-color)',
  'token-string': 'var(--jp-mirror-editor-string-color)',
  'token-string-expression': 'var(--jp-mirror-editor-string-2-color)',
  'token-comment': 'var(--jp-mirror-editor-comment-color)',
  'token-constant': 'var(--jp-mirror-editor-number-color)',
  'token-function': 'var(--jp-mirror-editor-def-color)',
  'token-parameter': 'var(--jp-mirror-editor-variable-color)',
  'token-punctuation': 'var(--jp-mirror-editor-punctuation-color)',
  'token-link': 'var(--jp-mirror-editor-link-color)'
};

/**
 * Register a Shiki theme whose token colors read JupyterLab's editor
 * variables. One theme per `type` (the library's own factory hardcodes
 * `type: 'dark'`): it must match the host's `themeType`, or `light-dark()`
 * reads an unset token variable and edited lines lose their colors.
 */
function registerJupyterlabTheme(name: string, type: 'light' | 'dark'): void {
  const theme = {
    ...createCSSVariablesTheme({
      name,
      variablePrefix: formatCSSVariablePrefix('global'),
      variableDefaults: JUPYTERLAB_THEME_VARIABLES,
      fontStyle: false
    }),
    type
  };
  registerCustomTheme(name, () => Promise.resolve(theme));
}

registerJupyterlabTheme('jupyterlab-light', 'light');
registerJupyterlabTheme('jupyterlab-dark', 'dark');

/**
 * Choose Pierre's palette or the JupyterLab CSS-variable theme.
 */
export function resolveDiffTheme(
  dark: boolean,
  pierreTheme: boolean
): DiffsThemeNames {
  if (pierreTheme) {
    return dark ? 'pierre-dark' : 'pierre-light';
  }
  return dark ? 'jupyterlab-dark' : 'jupyterlab-light';
}
