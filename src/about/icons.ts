import { LabIcon } from '@jupyterlab/ui-components';

import aboutLogoSvgstr from '../../style/icons/about-logo.svg';

/**
 * Flask mark from the project logo (logo.png), hand-redrawn as a compact SVG
 * (style/icons/about-logo.svg) so the About dialog gets a crisp vector at any
 * size. Brand colors are sampled from the artwork; the white glass and navy
 * outline match both the light and dark logo variants, so no per-theme
 * handling is needed.
 */
export const aboutLogoIcon = new LabIcon({
  name: 'xtralab:about-logo',
  svgstr: aboutLogoSvgstr
});
