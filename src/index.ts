import { JupyterFrontEndPlugin } from '@jupyterlab/application';

import fileBrowserPlugin from './fileBrowser';
import editorBreadcrumbsPlugin from './editorBreadcrumbs';
import gitPlugin from './git';
import launcherPlugin from './launcher';
import menusPlugin from './menus';
import sidebarPlugin from './sidebar';
import statusBarPlugin from './statusBar';

/**
 * Every plugin contributed by `xtralab`. The entry point of the
 * labextension is an array because the package bundles several independent
 * enhancements (file browser, git changes panel, …) — JupyterLab activates
 * each plugin individually and only the ones whose required tokens are
 * available end up running.
 */
const plugins: JupyterFrontEndPlugin<unknown>[] = [
  editorBreadcrumbsPlugin,
  fileBrowserPlugin,
  gitPlugin,
  launcherPlugin,
  menusPlugin,
  sidebarPlugin,
  statusBarPlugin
];

export default plugins;
