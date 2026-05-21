import { LabIcon } from '@jupyterlab/ui-components';

/**
 * Mirror-symmetric "toggle sidebar" marks for the top-bar buttons, in the
 * same visual language as the macOS / VS Code / svgrepo sidebar icons
 * (https://www.svgrepo.com/vectors/sidebar/): a rounded window outline split
 * by a divider, with the controlled side shaded so left vs. right reads at a
 * glance. The artwork is hand-authored from basic geometry (rounded rect +
 * divider + a shaded panel) so there is no third-party licensing to track,
 * and every stroke/fill uses `currentColor` so the icons inherit the top
 * bar's text color across the light and dark themes.
 */

export const leftSidebarIcon = new LabIcon({
  name: 'xtralab:sidebar-left',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <path d="M9 3H5.5A2.5 2.5 0 0 0 3 5.5V18.5A2.5 2.5 0 0 0 5.5 21H9Z" fill="currentColor" fill-opacity="0.3"/>
  <rect x="3" y="3" width="18" height="18" rx="2.5" stroke="currentColor" stroke-width="1.7"/>
  <line x1="9" y1="3" x2="9" y2="21" stroke="currentColor" stroke-width="1.7"/>
</svg>`
});

export const rightSidebarIcon = new LabIcon({
  name: 'xtralab:sidebar-right',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <path d="M15 3H18.5A2.5 2.5 0 0 1 21 5.5V18.5A2.5 2.5 0 0 1 18.5 21H15Z" fill="currentColor" fill-opacity="0.3"/>
  <rect x="3" y="3" width="18" height="18" rx="2.5" stroke="currentColor" stroke-width="1.7"/>
  <line x1="15" y1="3" x2="15" y2="21" stroke="currentColor" stroke-width="1.7"/>
</svg>`
});
