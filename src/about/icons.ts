import { LabIcon } from '@jupyterlab/ui-components';

import logoSvgstr from '../../logo.svg';

/**
 * The project logo mark — the repo-root `logo.svg` the README and docs also
 * use, inlined by the labextension build.
 */
export const aboutLogoIcon = new LabIcon({
  name: 'xtralab:about-logo',
  svgstr: logoSvgstr
});
