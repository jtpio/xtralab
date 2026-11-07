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
