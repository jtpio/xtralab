import { LabIcon } from '@jupyterlab/ui-components';

import logoSvgstr from '../../logo.svg';

/**
 * The project logo mark — `logo.svg` at the repository root, the same file
 * the README and the docs site use. The labextension build inlines it as a
 * raw string, so the dialog always shows the current artwork.
 */
export const aboutLogoIcon = new LabIcon({
  name: 'xtralab:about-logo',
  svgstr: logoSvgstr
});
