import { JupyterFrontEndPlugin } from '@jupyterlab/application';

import aboutPlugin from './about';
import agentSessionsPlugin from './agentSessions';
import askAgentPlugin from './askAgent';
import commandBarPlugin from './commandBar';
import customPanelPlugin from './customPanel';
import fileBrowserPlugin from './fileBrowser';
import fileTypeIconsPlugin from './fileTypeIcons';
import editorBreadcrumbsPlugin from './editorBreadcrumbs';
import editorIndentPlugin from './editorIndent';
import gitPlugins from './git';
import highlightPlugin from './highlight';
import launcherPlugins from './launcher';
import menuBarPlugin from './menuBar';
import menusPlugin from './menus';
import omniboxPlugin from './omnibox';
import searchReplacePlugin from './searchReplace';
import showOutputPlugin from './showOutput';
import sidebarPlugin from './sidebar';
import terminalNotificationsPlugin from './terminalNotifications';
import terminalsPlugin from './terminals';
import topBarPlugin from './topBar';
import walkthroughPlugin from './walkthrough';

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
  aboutPlugin,
  agentSessionsPlugin,
  askAgentPlugin,
  commandBarPlugin,
  customPanelPlugin,
  editorBreadcrumbsPlugin,
  editorIndentPlugin,
  fileBrowserPlugin,
  fileTypeIconsPlugin,
  ...gitPlugins,
  highlightPlugin,
  ...launcherPlugins,
  menuBarPlugin,
  menusPlugin,
  omniboxPlugin,
  searchReplacePlugin,
  showOutputPlugin,
  sidebarPlugin,
  terminalNotificationsPlugin,
  terminalsPlugin,
  topBarPlugin,
  walkthroughPlugin
];

export default plugins;
