import {
  registerCustomCSSVariableTheme,
  type DiffsThemeNames
} from '@pierre/diffs';

/**
 * Shiki CSS-variable theme used for non-Pierre JupyterLab themes.
 */
const JUPYTERLAB_DIFF_THEME: DiffsThemeNames = 'jupyterlab';

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

/**
 * `unsafeCSS` for a taller, always-visible horizontal scrollbar. The library
 * default is 6px and only paints the thumb on hover, in a color close to the
 * background, so users miss that long lines scroll. Same thumb color as the
 * app scrollbars in chrome.css.
 */
export const DIFF_SCROLLBAR_CSS = `:host {
  --diffs-scrollbar-gutter-override: 10px;
  --xtralab-diff-scrollbar-thumb: color-mix(in srgb, var(--jp-ui-font-color1) 28%, transparent);
}
[data-code]::-webkit-scrollbar-thumb {
  background-color: var(--xtralab-diff-scrollbar-thumb);
  border-width: 2px;
  border-radius: 999px;
}
[data-code]::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--jp-ui-font-color1) 45%, transparent);
}
@supports (-moz-appearance: none) {
  [data-code] {
    scrollbar-color: var(--xtralab-diff-scrollbar-thumb) transparent;
  }
}`;

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
  return JUPYTERLAB_DIFF_THEME;
}
