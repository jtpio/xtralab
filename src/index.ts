import { JupyterFrontEndPlugin } from '@jupyterlab/application';

import fileBrowserPlugin from './fileBrowser';
import editorBreadcrumbsPlugin from './editorBreadcrumbs';
import editorIndentPlugin from './editorIndent';
import gitPlugins from './git';
import launcherPlugin from './launcher';
import menusPlugin from './menus';
import sidebarPlugin from './sidebar';
import terminalsPlugin from './terminals';

/**
 * Every plugin contributed by `xtralab`. The entry point of the
 * labextension is an array because the package bundles several independent
 * enhancements (file browser, git diff providers, …) — JupyterLab activates
 * each plugin individually and only the ones whose required tokens are
 * available end up running. `gitPlugins` is itself an array (the launcher
 * diff command + the jupyterlab-git diff providers), so it is spread in.
 */
const plugins: JupyterFrontEndPlugin<unknown>[] = [
  editorBreadcrumbsPlugin,
  editorIndentPlugin,
  fileBrowserPlugin,
  ...gitPlugins,
  launcherPlugin,
  menusPlugin,
  sidebarPlugin,
  terminalsPlugin
];

export default plugins;
