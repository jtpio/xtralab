import { LabIcon } from '@jupyterlab/ui-components';

/**
 * A magnifier mark for the top-bar command bar, hand-authored from basic
 * geometry (a circle and a handle) so there is no third-party licensing to
 * track. Both strokes use `currentColor` so the icon inherits the command
 * bar's text color across the light and dark themes, matching the sidebar
 * marks in topBar/icons.ts.
 */
export const searchIcon = new LabIcon({
  name: 'xtralab:command-bar-search',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="2"/>
  <line x1="15.2" y1="15.2" x2="20" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`
});
