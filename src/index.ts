import { JupyterFrontEndPlugin } from '@jupyterlab/application';

import fileBrowserPlugin from './fileBrowser';
import gitPlugin from './git';

/**
 * Every plugin contributed by `xtralab`. The entry point of the
 * labextension is an array because the package bundles several independent
 * enhancements (file browser, git changes panel, …) — JupyterLab activates
 * each plugin individually and only the ones whose required tokens are
 * available end up running.
 */
const plugins: JupyterFrontEndPlugin<unknown>[] = [
  fileBrowserPlugin,
  gitPlugin
];

export default plugins;
