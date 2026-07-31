import { LabIcon } from '@jupyterlab/ui-components';

/**
 * Hamburger mark for the collapsed main-menu button, in the same hand-drawn
 * visual language as the sidebar toggles in ../topBar/icons.ts: basic
 * geometry, `currentColor` strokes so the icon follows the top bar's text
 * color across themes, and no third-party artwork to license.
 */
export const mainMenuIcon = new LabIcon({
  name: 'xtralab:main-menu',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <line x1="4.5" y1="7" x2="19.5" y2="7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  <line x1="4.5" y1="12" x2="19.5" y2="12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  <line x1="4.5" y1="17" x2="19.5" y2="17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
</svg>`
});
