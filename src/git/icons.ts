import { LabIcon } from '@jupyterlab/ui-components';

/**
 * The branch glyph used as the git panel's sidebar tab icon. Defined as a
 * `LabIcon` (rather than a CSS-only mask) so it picks up JupyterLab's icon
 * recoloring and inverse-color sidebar painting automatically.
 *
 * Source: `git-branch` from SVG Repo (https://www.svgrepo.com/svg/377352/git-branch),
 * part of the same Pixelarticons family as the Xtralab file browser's `file-tree`
 * icon, so the two sidebar tab glyphs read as a matched set. The original
 * `fill="#000000"` is replaced with `fill="currentColor"` and the root element
 * is given the `jp-icon3` class so the icon picks up JupyterLab's theme color
 * and the sidebar's inverse-color painting automatically.
 */
export const gitIcon = new LabIcon({
  name: 'xtralab:git',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="jp-icon3" fill="currentColor">
  <path d="M5 2h2v12h3v3h7v-7h-3V2h8v8h-3v9h-9v3H2v-8h3V2zm15 6V4h-4v4h4zM8 19v-3H4v4h4v-1z"/>
</svg>`
});
