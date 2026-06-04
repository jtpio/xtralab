import {
  registerCustomCSSVariableTheme,
  type DiffsThemeNames
} from '@pierre/diffs';

/** Shiki CSS-variable theme used for non-Pierre JupyterLab themes. */
export const JUPYTERLAB_DIFF_THEME: DiffsThemeNames = 'jupyterlab';

/**
 * Register a Shiki theme whose token colors read JupyterLab's editor
 * variables. The values are CSS variables, so theme changes recolor the diff.
 */
registerCustomCSSVariableTheme(JUPYTERLAB_DIFF_THEME, {
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
});

/** Choose Pierre's palette or the JupyterLab CSS-variable theme. */
export function resolveDiffTheme(
  dark: boolean,
  pierreTheme: boolean
): DiffsThemeNames {
  if (pierreTheme) {
    return dark ? 'pierre-dark' : 'pierre-light';
  }
  return JUPYTERLAB_DIFF_THEME;
}
