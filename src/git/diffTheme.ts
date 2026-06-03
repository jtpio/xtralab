import {
  registerCustomCSSVariableTheme,
  type DiffsThemeNames
} from '@pierre/diffs';

/**
 * Name of the Shiki "CSS variables" theme registered below.
 * {@link resolveDiffTheme} selects it for any non-Pierre JupyterLab theme.
 */
export const JUPYTERLAB_DIFF_THEME: DiffsThemeNames = 'jupyterlab';

/**
 * Register a Shiki theme whose token colors resolve to JupyterLab's
 * `--jp-mirror-editor-*` editor variables.
 *
 * `@pierre/diffs` builds on Shiki's CSS-variable theme support: each token is
 * emitted as `var(--diffs-token-<name>, <default>)`. Pointing the defaults at
 * the editor variables makes the diff's syntax highlighting follow the active
 * JupyterLab theme — the same variables the CodeMirror editor reads — instead
 * of Pierre's fixed palette. Because the values are read live from the DOM,
 * switching the JupyterLab theme recolors the diff without re-rendering.
 *
 * Registered once at module load (main thread, before any diff renders).
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

/**
 * Choose the diff viewer's Shiki theme. A Pierre JupyterLab theme keeps
 * Pierre's rich highlighting (`pierre-light` / `pierre-dark`); every other
 * theme uses the CSS-variable theme above so the diff matches the active
 * editor colors.
 */
export function resolveDiffTheme(
  dark: boolean,
  pierreTheme: boolean
): DiffsThemeNames {
  if (pierreTheme) {
    return dark ? 'pierre-dark' : 'pierre-light';
  }
  return JUPYTERLAB_DIFF_THEME;
}
