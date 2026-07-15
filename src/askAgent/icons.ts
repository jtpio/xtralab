import { LabIcon } from '@jupyterlab/ui-components';

/**
 * Four-point sparkle used by the ask-agent affordances (selection pill,
 * command palette entry). Drawn in-repo; the `jp-icon3` class lets the
 * active theme recolor the glyph like other JupyterLab UI icons.
 */
export const askAgentIcon = new LabIcon({
  name: 'xtralab:ask-agent',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <g class="jp-icon3" fill="#616161">
    <path d="M6 1l1 4 4 1-4 1-1 4-1-4-4-1 4-1 1-4z"/>
    <path d="M12 9l.7 2.3L15 12l-2.3.7L12 15l-.7-2.3L9 12l2.3-.7L12 9z"/>
  </g>
</svg>`
});
