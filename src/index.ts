import { JupyterFrontEndPlugin } from '@jupyterlab/application';

import agentSessionsPlugin from './agentSessions';
import fileBrowserPlugin from './fileBrowser';
import fileTypeIconsPlugin from './fileTypeIcons';
import editorBreadcrumbsPlugin from './editorBreadcrumbs';
import editorIndentPlugin from './editorIndent';
import gitPlugins from './git';
import launcherPlugins from './launcher';
import menusPlugin from './menus';
import sidebarPlugin from './sidebar';
import terminalNotificationsPlugin from './terminalNotifications';
import terminalsPlugin from './terminals';
import topBarPlugin from './topBar';

/**
 * Every plugin contributed by `xtralab`. The entry point of the
 * labextension is an array because the package bundles several independent
 * enhancements (file browser, git diff providers, …) — JupyterLab activates
 * each plugin individually and only the ones whose required tokens are
 * available end up running. `gitPlugins` and `launcherPlugins` are themselves
 * arrays (the git diff providers; the launcher plus its editor registry), so
 * they are spread in.
 */
const plugins: JupyterFrontEndPlugin<unknown>[] = [
  agentSessionsPlugin,
  editorBreadcrumbsPlugin,
  editorIndentPlugin,
  fileBrowserPlugin,
  fileTypeIconsPlugin,
  ...gitPlugins,
  ...launcherPlugins,
  menusPlugin,
  sidebarPlugin,
  terminalNotificationsPlugin,
  terminalsPlugin,
  topBarPlugin
];

export default plugins;
