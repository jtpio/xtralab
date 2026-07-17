import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream
} from 'node:fs';
import * as path from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron';

interface ServerInfo {
  url: string;
  baseUrl: string;
  token: string;
}

interface SupervisorExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

interface SupervisorHandle {
  process: ChildProcessWithoutNullStreams;
  ready: Promise<ServerInfo>;
  exited: Promise<SupervisorExitInfo>;
  stop: () => Promise<void>;
}

interface ManagedEnvironment {
  envDir: string;
  binDir: string;
  pythonPath: string;
  xtralabPath: string;
}

interface PythonEnvironmentOption {
  label: string;
  detail: string;
  kind: 'managed' | 'project' | 'custom';
  pythonPath: string | null;
  environmentRoot: string | null;
  hasIpykernel: boolean;
}

interface FolderEnvironmentResult {
  ok: boolean;
  folderPath?: string;
  environments?: PythonEnvironmentOption[];
  selectedPythonPath?: string | null;
  error?: string;
}

interface ProjectRuntimeEnvironment {
  option: PythonEnvironmentOption;
  kernelDataPath: string;
}

interface FolderEnvironmentPreference {
  pythonPath: string | null;
  updatedAt: string;
}

interface LabSession {
  folderPath: string;
  projectEnvironment: ProjectRuntimeEnvironment | null;
  supervisor: SupervisorHandle;
  window: BrowserWindow;
}

interface OpenFolderResult {
  ok: boolean;
  folderPath?: string;
  error?: string;
}

const recentFoldersLimit = 8;
const launcherContentWidth = 720;
const launcherContentHeight = 640;
const launcherMinContentWidth = 560;
const launcherMinContentHeight = 480;
const labSessions = new Map<number, LabSession>();
const pendingSupervisors = new Set<SupervisorHandle>();
// Lab windows share this identifier so macOS follows the user's "Prefer tabs
// when opening documents" setting when grouping them, and so the Window menu
// and tab bar can merge or split them on demand.
const labWindowTabbingIdentifier = 'xtralab-project';

let launcherWindow: BrowserWindow | null = null;
// Whether the launcher window currently lives as a native macOS tab inside a
// lab window's tab group (opened from the tab bar "+" or File > New Tab).
// While true, a project picked in the launcher joins that group as a tab in
// the launcher tab's place instead of opening as a separate window.
let launcherOpenedAsTab = false;
let logStream: WriteStream | null = null;
let recentFolders: string[] = [];
let folderEnvironmentPreferences: Record<string, FolderEnvironmentPreference> =
  {};
let quitInProgress = false;
let ipcRegistered = false;

if (!app.isPackaged) {
  app.setName('xtralab dev');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showLauncherWindow();
  });
  app
    .whenReady()
    .then(startApplication)
    .catch(error => {
      showStartupError(error);
      app.quit();
    });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    showLauncherWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void shutdownAndQuit();
  }
});

app.on('before-quit', event => {
  if (
    quitInProgress ||
    (labSessions.size === 0 && pendingSupervisors.size === 0)
  ) {
    return;
  }

  event.preventDefault();
  void shutdownAndQuit();
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => {
    event.preventDefault();
  });
});

function startApplication(): void {
  initializeLogging();
  configureApplicationMenu();
  prepareProcessEnvironment();
  setApplicationIcon();
  cleanupStaleJupyterServers();
  loadRecentFolders();
  loadFolderEnvironmentPreferences();
  registerIpcHandlers();
  showLauncherWindow();
}

function initializeLogging(): void {
  const logsDir = path.join(app.getPath('userData'), 'logs');
  mkdirSync(logsDir, { recursive: true });
  logStream = createWriteStream(path.join(logsDir, 'main.log'), {
    flags: 'a'
  });
  log('Starting xtralab desktop');
}

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  logStream?.write(`${line}\n`);
  console.log(line);
}

function configureApplicationMenu(): void {
  const appName = app.getName();
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: appName,
            submenu: [
              { role: 'about', label: `About ${appName}` },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: `Hide ${appName}` },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: `Quit ${appName}` }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            showLauncherWindow();
          }
        },
        ...(process.platform === 'darwin'
          ? [
              {
                label: 'New Tab',
                accelerator: 'CmdOrCtrl+T',
                click: () => {
                  openLauncherTabForFocusedWindow();
                }
              } satisfies MenuItemConstructorOptions
            ]
          : []),
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            showLauncherWindow();
          }
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        ...(process.platform === 'darwin'
          ? [
              { role: 'toggleTabBar' } satisfies MenuItemConstructorOptions,
              { type: 'separator' } satisfies MenuItemConstructorOptions
            ]
          : []),
        { role: 'togglefullscreen' }
      ]
    },
    {
      role: 'windowMenu',
      submenu:
        process.platform === 'darwin'
          ? [
              { role: 'minimize' },
              { role: 'zoom' },
              { type: 'separator' },
              {
                role: 'selectPreviousTab',
                label: 'Show Previous Tab',
                accelerator: 'Control+Shift+Tab'
              },
              {
                role: 'selectNextTab',
                label: 'Show Next Tab',
                accelerator: 'Control+Tab'
              },
              { role: 'moveTabToNewWindow', label: 'Move Tab to New Window' },
              { role: 'mergeAllWindows', label: 'Merge All Windows' },
              { type: 'separator' },
              { role: 'front' }
            ]
          : [{ role: 'minimize' }, { role: 'close' }]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Show Logs',
          click: async () => {
            await shell.openPath(getLogsDir());
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function prepareProcessEnvironment(): void {
  const mergedPath = composeRuntimePath();
  if (mergedPath.length === 0) {
    log('Unable to prepare a usable process PATH');
    return;
  }

  process.env.PATH = mergedPath;
  log(`Prepared process PATH: ${mergedPath}`);
}

function getConfiguredExtraPath(): string | undefined {
  return process.env.XTRALAB_EXTRA_PATH;
}

function getDefaultExternalCommandPath(): string {
  const home = app.getPath('home');
  const candidates = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.mise', 'shims'),
    path.join(home, '.pixi', 'bin'),
    path.join(home, '.rye', 'shims'),
    path.join(home, '.deno', 'bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ];

  return candidates
    .filter(candidate => existsSync(candidate))
    .join(path.delimiter);
}

function composeRuntimePath(prefix?: string): string {
  return mergePathSegments([
    prefix,
    getConfiguredExtraPath(),
    removeActivePythonEnvironmentPath(process.env.PATH),
    getDefaultExternalCommandPath()
  ]);
}

function mergePathSegments(paths: Array<string | undefined>): string {
  const seen = new Set<string>();
  const segments: string[] = [];

  for (const candidatePath of paths) {
    if (!candidatePath) {
      continue;
    }
    for (const segment of candidatePath.split(path.delimiter)) {
      if (segment.length === 0 || seen.has(segment)) {
        continue;
      }
      seen.add(segment);
      segments.push(segment);
    }
  }

  return segments.join(path.delimiter);
}

function removeActivePythonEnvironmentPath(
  candidatePath: string | undefined
): string | undefined {
  if (candidatePath === undefined) {
    return undefined;
  }

  const activeEnvironmentBins = getActivePythonEnvironmentBins();
  if (activeEnvironmentBins.size === 0) {
    return candidatePath;
  }

  return candidatePath
    .split(path.delimiter)
    .filter(segment => {
      if (segment.length === 0) {
        return false;
      }
      return !activeEnvironmentBins.has(path.resolve(segment));
    })
    .join(path.delimiter);
}

function getActivePythonEnvironmentBins(): Set<string> {
  const bins = new Set<string>();
  const environmentRoots = [
    process.env.VIRTUAL_ENV,
    process.env.CONDA_PREFIX,
    process.env.UV_PROJECT_ENVIRONMENT
  ];

  for (const environmentRoot of environmentRoots) {
    if (environmentRoot === undefined || environmentRoot.length === 0) {
      continue;
    }
    bins.add(path.resolve(getManagedEnvironmentBinDir(environmentRoot)));
  }

  return bins;
}

function clearInheritedPythonEnvironment(environment: NodeJS.ProcessEnv): void {
  delete environment.CONDA_DEFAULT_ENV;
  delete environment.CONDA_PREFIX;
  delete environment.CONDA_PROMPT_MODIFIER;
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  delete environment.UV_PROJECT_ENVIRONMENT;
  delete environment.VIRTUAL_ENV;
  delete environment.VIRTUAL_ENV_PROMPT;
}

function setApplicationIcon(): void {
  const icon = nativeImage.createFromPath(getPngIconPath());
  if (!icon.isEmpty() && process.platform === 'darwin') {
    app.dock?.setIcon(icon);
  }
}

function registerIpcHandlers(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle('xtralab:get-home-dir', () => app.getPath('home'));
  ipcMain.handle('xtralab:get-recent-folders', () => getRecentFolders());
  ipcMain.handle(
    'xtralab:forget-recent-folder',
    (event: IpcMainInvokeEvent, folderPath: unknown) => {
      if (typeof folderPath !== 'string') {
        return getRecentFolders();
      }
      return forgetRecentFolder(folderPath);
    }
  );
  ipcMain.handle('xtralab:clear-recent-folders', () => clearRecentFolders());
  ipcMain.handle('xtralab:show-logs', async () => {
    await shell.openPath(getLogsDir());
  });
  ipcMain.handle(
    'xtralab:notify',
    (
      event: IpcMainInvokeEvent,
      title: unknown,
      body: unknown,
      session: unknown
    ) => {
      if (typeof title !== 'string' || typeof body !== 'string') {
        return;
      }
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      // Only a live lab window may post, and only within a rate limit: the
      // renderer throttle is bypassable by any script on the page.
      if (senderWindow === null || !labSessions.has(senderWindow.id)) {
        return;
      }
      if (!allowNotification(senderWindow.id)) {
        return;
      }
      deliverDesktopNotification(
        title,
        body,
        senderWindow,
        typeof session === 'string' ? session : null
      );
    }
  );
  ipcMain.handle('xtralab:open-folder-dialog', async event => {
    return prepareFolderFromDialog(BrowserWindow.fromWebContents(event.sender));
  });
  ipcMain.handle(
    'xtralab:prepare-folder',
    async (_event: IpcMainInvokeEvent, folderPath: unknown) => {
      if (typeof folderPath !== 'string') {
        return {
          ok: false,
          error: 'Invalid folder path'
        } satisfies FolderEnvironmentResult;
      }
      return prepareFolder(folderPath);
    }
  );
  ipcMain.handle(
    'xtralab:select-python-interpreter',
    async (event: IpcMainInvokeEvent, folderPath: unknown) => {
      if (typeof folderPath !== 'string') {
        return {
          ok: false,
          error: 'Invalid folder path'
        } satisfies FolderEnvironmentResult;
      }
      return selectPythonInterpreter(
        folderPath,
        BrowserWindow.fromWebContents(event.sender)
      );
    }
  );
  ipcMain.handle(
    'xtralab:open-recent-folder',
    async (event: IpcMainInvokeEvent, folderPath: unknown) => {
      if (typeof folderPath !== 'string') {
        return {
          ok: false,
          error: 'Invalid folder path'
        } satisfies OpenFolderResult;
      }
      return prepareFolder(folderPath);
    }
  );
  ipcMain.handle(
    'xtralab:open-folder',
    async (
      event: IpcMainInvokeEvent,
      folderPath: unknown,
      pythonPath: unknown
    ) => {
      if (
        typeof folderPath !== 'string' ||
        (typeof pythonPath !== 'string' && pythonPath !== null)
      ) {
        return {
          ok: false,
          error: 'Invalid folder environment'
        } satisfies OpenFolderResult;
      }
      return openFolder(
        folderPath,
        BrowserWindow.fromWebContents(event.sender),
        pythonPath
      );
    }
  );
}

// Recent notification timestamps per lab-window id, consulted by
// `allowNotification`. Pruned when a lab window closes.
const notificationTimestamps = new Map<number, number[]>();
const NOTIFICATION_RATE_WINDOW_MS = 10_000;
const NOTIFICATION_RATE_MAX = 6;

// Sliding-window rate limit per window. The renderer already throttles per
// terminal, so this only trips on a runaway loop or a direct bridge caller.
function allowNotification(windowId: number): boolean {
  const now = Date.now();
  const recent = (notificationTimestamps.get(windowId) ?? []).filter(
    timestamp => now - timestamp < NOTIFICATION_RATE_WINDOW_MS
  );
  if (recent.length >= NOTIFICATION_RATE_MAX) {
    notificationTimestamps.set(windowId, recent);
    return false;
  }
  recent.push(now);
  notificationTimestamps.set(windowId, recent);
  return true;
}

// Whether the running app bundle carries a real (non-ad-hoc) code signature.
// macOS only delivers native notifications from a stably-signed bundle, so this
// decides between the native Notification and the osascript fallback. codesign
// is a subprocess, so the result is cached.
let cachedAppSigned: boolean | null = null;
function isAppProperlySigned(): boolean {
  if (cachedAppSigned !== null) {
    return cachedAppSigned;
  }
  cachedAppSigned = false;
  try {
    // process.execPath is <app>.app/Contents/MacOS/<exe>; the bundle is 3 up.
    const bundlePath = path.resolve(process.execPath, '..', '..', '..');
    const result = spawnSync('codesign', ['-dvv', bundlePath], {
      encoding: 'utf8',
      timeout: 5000
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    cachedAppSigned =
      result.status === 0 &&
      /Authority=/.test(output) &&
      !/Signature=adhoc/.test(output);
  } catch {
    cachedAppSigned = false;
  }
  return cachedAppSigned;
}

// Deliver a desktop notification forwarded from a terminal.
//
// macOS only delivers a native Notification from a real (non-ad-hoc) signature;
// an unsigned bundle is silently dropped. So a signed packaged build (Developer
// ID, or a self-signed cert) uses the native Notification (xtralab's icon and
// click-to-focus), while everything else on macOS (`pnpm dev`, or an unsigned
// release) falls back to `osascript`, which always delivers but carries no click
// action. Linux/Windows always use native.
function deliverDesktopNotification(
  rawTitle: string,
  rawBody: string,
  senderWindow: BrowserWindow | null,
  session: string | null
): void {
  const title = sanitizeNotificationText(rawTitle);
  const body = sanitizeNotificationText(rawBody);
  const useOsascript =
    process.platform === 'darwin' && !(app.isPackaged && isAppProperlySigned());

  if (useOsascript) {
    // `display notification` needs body text (the title is only the secondary
    // line), so fold a body-less notification down into the body. This is an
    // AppleScript requirement, so it stays scoped to the osascript path.
    let osaTitle = title;
    let osaBody = body;
    if (osaBody.length === 0) {
      osaBody = osaTitle || app.getName();
      osaTitle = app.getName();
    }
    if (osaTitle.length === 0) {
      osaTitle = app.getName();
    }

    // Pass the strings as AppleScript arguments (`on run argv`) instead of
    // interpolating them into the script source, so a title/body containing
    // quotes or backslashes can neither break the script nor inject into it.
    const child = spawn(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        '--',
        osaTitle,
        osaBody
      ],
      { stdio: 'ignore' }
    );
    child.on('error', error => {
      log(
        `Unable to deliver notification via osascript: ${formatError(error)}`
      );
    });
    child.unref();
    return;
  }

  if (!Notification.isSupported()) {
    return;
  }
  // Native notifications allow an empty body (the title shows alone), so no
  // folding is needed here.
  const notification = new Notification({
    title: title || app.getName(),
    body
  });
  notification.on('click', () => {
    if (senderWindow !== null && !senderWindow.isDestroyed()) {
      if (senderWindow.isMinimized()) {
        senderWindow.restore();
      }
      senderWindow.focus();
      // Activate the terminal that fired this notification, not just the window.
      if (session !== null) {
        senderWindow.webContents.send('xtralab:focus-terminal', session);
      }
    }
  });
  notification.show();
}

function sanitizeNotificationText(value: string): string {
  // Drop control characters (so a notification can't carry terminal escape
  // sequences), collapse whitespace, and clamp the length so a runaway message
  // can't flood Notification Center.
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    result += isControl ? ' ' : char;
  }
  return result.replace(/\s+/g, ' ').trim().slice(0, 256);
}

function showLauncherWindow(): void {
  if (launcherWindow !== null && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    launcherWindow.focus();
    return;
  }

  launcherWindow = createLauncherWindow(null);
}

// Open the launcher as a native tab in hostWindow's tab group, so picking a
// project there feels like opening a browser tab. Reuses the existing
// launcher window when there is one, moving it into the group.
function openLauncherTab(hostWindow: BrowserWindow): void {
  if (process.platform !== 'darwin') {
    showLauncherWindow();
    return;
  }

  if (launcherWindow !== null && !launcherWindow.isDestroyed()) {
    if (attachWindowAsTab(hostWindow, launcherWindow)) {
      launcherOpenedAsTab = true;
    }
    launcherWindow.show();
    launcherWindow.focus();
    return;
  }

  launcherWindow = createLauncherWindow(hostWindow);
}

function openLauncherTabForFocusedWindow(): void {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow !== null && labSessions.has(focusedWindow.id)) {
    openLauncherTab(focusedWindow);
    return;
  }
  showLauncherWindow();
}

// macOS only: addTabbedWindow throws when the host window cannot take a tab
// (for example because it was destroyed in the meantime), in which case the
// window is left to show as a regular window.
function attachWindowAsTab(
  hostWindow: BrowserWindow,
  window: BrowserWindow
): boolean {
  try {
    hostWindow.addTabbedWindow(window);
    return true;
  } catch (error) {
    log(`Unable to attach window as a tab: ${formatError(error)}`);
    return false;
  }
}

function createLauncherWindow(tabHost: BrowserWindow | null): BrowserWindow {
  const window = new BrowserWindow({
    title: app.getName(),
    useContentSize: true,
    width: launcherContentWidth,
    height: launcherContentHeight,
    minWidth: launcherMinContentWidth,
    minHeight: launcherMinContentHeight,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f2f1ee',
    icon: getPngIconPath(),
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    }
  });

  launcherOpenedAsTab = false;
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url, null);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => {
    event.preventDefault();
  });
  window.webContents.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle(app.getName());
  });
  window.once('ready-to-show', () => {
    if (
      tabHost !== null &&
      !tabHost.isDestroyed() &&
      attachWindowAsTab(tabHost, window)
    ) {
      launcherOpenedAsTab = true;
    }
    window.show();
  });
  window.on('closed', () => {
    if (launcherWindow === window) {
      launcherWindow = null;
      launcherOpenedAsTab = false;
    }
  });

  void window.loadFile(getLauncherHtmlPath());
  return window;
}

async function prepareFolderFromDialog(
  parentWindow: BrowserWindow | null = launcherWindow
): Promise<FolderEnvironmentResult> {
  const dialogOptions: Electron.OpenDialogOptions = {
    title: 'Open Folder',
    properties: ['openDirectory', 'createDirectory']
  };
  const result =
    parentWindow === null
      ? await dialog.showOpenDialog(dialogOptions)
      : await dialog.showOpenDialog(parentWindow, dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false };
  }

  return prepareFolder(result.filePaths[0]);
}

async function prepareFolder(
  folderPath: string
): Promise<FolderEnvironmentResult> {
  let resolvedFolder: string;
  try {
    resolvedFolder = normalizeFolderPath(folderPath);
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }

  try {
    const environments = discoverFolderPythonEnvironments(resolvedFolder);
    const selectedPythonPath = choosePreferredPythonPath(
      resolvedFolder,
      environments
    );
    return {
      ok: true,
      folderPath: resolvedFolder,
      environments,
      selectedPythonPath
    };
  } catch (error) {
    log(`Unable to inspect ${resolvedFolder}: ${formatError(error)}`);
    return { ok: false, folderPath: resolvedFolder, error: formatError(error) };
  }
}

async function openFolder(
  folderPath: string,
  sourceWindow: BrowserWindow | null = launcherWindow,
  pythonPath: string | null | undefined
): Promise<OpenFolderResult> {
  let resolvedFolder: string;
  try {
    resolvedFolder = normalizeFolderPath(folderPath);
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }

  const sourceLauncher =
    sourceWindow !== null &&
    sourceWindow === launcherWindow &&
    !sourceWindow.isDestroyed()
      ? sourceWindow
      : null;
  // When the launcher lives as a tab in a lab window's tab group, the new
  // project joins that group as a tab in the launcher tab's place instead of
  // opening as a separate window.
  const attachAsTab =
    process.platform === 'darwin' &&
    sourceLauncher !== null &&
    launcherOpenedAsTab;

  try {
    await createLabSession(
      resolvedFolder,
      pythonPath,
      sourceLauncher,
      attachAsTab
    );
    rememberFolderEnvironmentPreference(resolvedFolder, pythonPath ?? null);
    rememberRecentFolder(resolvedFolder);
    return { ok: true, folderPath: resolvedFolder };
  } catch (error) {
    log(`Unable to open ${resolvedFolder}: ${formatError(error)}`);
    return { ok: false, folderPath: resolvedFolder, error: formatError(error) };
  }
}

async function createLabSession(
  folderPath: string,
  pythonPath: string | null | undefined,
  sourceLauncher: BrowserWindow | null,
  attachAsTab: boolean
): Promise<void> {
  const managedEnvironment = getManagedEnvironment();
  const projectEnvironment = prepareProjectRuntimeEnvironment(
    folderPath,
    pythonPath,
    managedEnvironment
  );
  const supervisor = startSupervisor(
    folderPath,
    managedEnvironment,
    projectEnvironment
  );
  pendingSupervisors.add(supervisor);

  let serverInfo: ServerInfo;
  try {
    serverInfo = await supervisor.ready;
  } catch (error) {
    pendingSupervisors.delete(supervisor);
    await supervisor.stop();
    throw error;
  }

  pendingSupervisors.delete(supervisor);
  createLabWindow(
    serverInfo,
    folderPath,
    supervisor,
    projectEnvironment,
    sourceLauncher,
    attachAsTab
  );
}

function discoverFolderPythonEnvironments(
  folderPath: string
): PythonEnvironmentOption[] {
  const options: PythonEnvironmentOption[] = [createManagedEnvironmentOption()];
  const candidates = new Map<string, 'project' | 'custom'>();

  for (const candidatePath of getProjectPythonCandidatePaths(folderPath)) {
    candidates.set(path.resolve(candidatePath), 'project');
  }

  const preference = folderEnvironmentPreferences[folderPath];
  if (preference?.pythonPath !== null && preference?.pythonPath !== undefined) {
    candidates.set(path.resolve(preference.pythonPath), 'custom');
  }

  for (const [candidatePath, kind] of candidates.entries()) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    try {
      options.push(inspectPythonEnvironment(folderPath, candidatePath, kind));
    } catch (error) {
      log(
        `Skipping Python interpreter ${candidatePath}: ${formatError(error)}`
      );
    }
  }

  return options;
}

function createManagedEnvironmentOption(): PythonEnvironmentOption {
  return {
    label: 'xtralab managed Python',
    detail: 'Bundled JupyterLab runtime',
    kind: 'managed',
    pythonPath: null,
    environmentRoot: getManagedEnvironmentDir(),
    hasIpykernel: true
  };
}

function getProjectPythonCandidatePaths(folderPath: string): string[] {
  const candidates: string[] = [];
  for (const environmentName of ['.venv', 'venv', 'env', '.conda']) {
    candidates.push(
      getPythonExecutablePath(path.join(folderPath, environmentName))
    );
  }

  const pixiEnvironmentsDir = path.join(folderPath, '.pixi', 'envs');
  try {
    for (const environmentName of readdirSync(pixiEnvironmentsDir)) {
      candidates.push(
        getPythonExecutablePath(path.join(pixiEnvironmentsDir, environmentName))
      );
    }
  } catch {
    // Projects without pixi environments are expected.
  }

  return candidates;
}

function getPythonExecutablePath(environmentRoot: string): string {
  return path.join(
    environmentRoot,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python'
  );
}

function inspectPythonEnvironment(
  folderPath: string,
  pythonPath: string,
  kind: 'project' | 'custom'
): PythonEnvironmentOption {
  const script = [
    'import importlib.util, json, os, sys',
    'print(json.dumps({',
    '"executable": sys.executable,',
    '"prefix": sys.prefix,',
    '"version": ".".join(str(part) for part in sys.version_info[:3]),',
    '"hasIpykernel": importlib.util.find_spec("ipykernel") is not None,',
    '}))'
  ].join('\n');
  const result = spawnSync(pythonPath, ['-I', '-c', script], {
    cwd: folderPath,
    encoding: 'utf8',
    env: getPythonInspectionEnvironment(pythonPath),
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Python inspection failed');
  }

  let inspection: {
    executable: string;
    prefix: string;
    version: string;
    hasIpykernel: boolean;
  };
  try {
    inspection = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `Python inspection returned invalid JSON: ${formatError(error)}`
    );
  }

  const resolvedPythonPath = path.resolve(inspection.executable || pythonPath);
  const environmentRoot = path.resolve(inspection.prefix);
  return {
    label: getPythonEnvironmentLabel(folderPath, environmentRoot, kind),
    detail: `Python ${inspection.version} - ${resolvedPythonPath}`,
    kind,
    pythonPath: resolvedPythonPath,
    environmentRoot,
    hasIpykernel: inspection.hasIpykernel
  };
}

function getPythonInspectionEnvironment(pythonPath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: composeRuntimePath(path.dirname(pythonPath)),
    PYTHONNOUSERSITE: '1'
  };
  clearInheritedPythonEnvironment(environment);
  return environment;
}

function getPythonEnvironmentLabel(
  folderPath: string,
  environmentRoot: string,
  kind: 'project' | 'custom'
): string {
  if (isPathInside(folderPath, environmentRoot)) {
    return (
      path.relative(folderPath, environmentRoot) || path.basename(folderPath)
    );
  }

  const baseName = path.basename(environmentRoot);
  return kind === 'custom' ? `Custom: ${baseName}` : baseName;
}

function choosePreferredPythonPath(
  folderPath: string,
  environments: PythonEnvironmentOption[]
): string | null {
  const preference = folderEnvironmentPreferences[folderPath];
  if (
    preference !== undefined &&
    environments.some(
      option =>
        option.pythonPath === preference.pythonPath &&
        (option.pythonPath === null || option.hasIpykernel)
    )
  ) {
    return preference.pythonPath;
  }

  const readyProjectEnvironment = environments.find(
    option => option.pythonPath !== null && option.hasIpykernel
  );
  if (readyProjectEnvironment !== undefined) {
    return readyProjectEnvironment.pythonPath;
  }

  return null;
}

function prepareProjectRuntimeEnvironment(
  folderPath: string,
  pythonPath: string | null | undefined,
  managedEnvironment: ManagedEnvironment
): ProjectRuntimeEnvironment | null {
  let selectedPythonPath: string | null;
  if (pythonPath === undefined) {
    const environments = discoverFolderPythonEnvironments(folderPath);
    selectedPythonPath = choosePreferredPythonPath(folderPath, environments);
  } else {
    selectedPythonPath = pythonPath;
  }

  if (selectedPythonPath === null) {
    return null;
  }

  if (
    path.resolve(selectedPythonPath) ===
    path.resolve(managedEnvironment.pythonPath)
  ) {
    return null;
  }

  const option = inspectPythonEnvironment(
    folderPath,
    selectedPythonPath,
    'custom'
  );
  if (!option.hasIpykernel) {
    log(`Project Python environment ${option.pythonPath} has no ipykernel`);
    return null;
  }

  const kernelDataPath = writeProjectKernelSpec(folderPath, option);
  log(
    `Using project Python environment ${option.pythonPath} for ${folderPath}`
  );

  return {
    option,
    kernelDataPath
  };
}

function writeProjectKernelSpec(
  folderPath: string,
  option: PythonEnvironmentOption
): string {
  if (option.pythonPath === null) {
    throw new Error('Cannot create a project kernelspec without a Python path');
  }

  const dataPath = getProjectKernelDataPath(folderPath);
  const kernelPath = path.join(dataPath, 'kernels', 'python3');
  mkdirSync(kernelPath, { recursive: true });
  writeFileSync(
    path.join(kernelPath, 'kernel.json'),
    `${JSON.stringify(
      {
        argv: [
          option.pythonPath,
          '-m',
          'ipykernel_launcher',
          '-f',
          '{connection_file}'
        ],
        display_name: getProjectKernelDisplayName(option),
        language: 'python',
        env: {
          PYTHONNOUSERSITE: '1'
        },
        metadata: {
          debugger: true,
          xtralab: {
            folderPath,
            environmentRoot: option.environmentRoot
          }
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  return dataPath;
}

function getProjectKernelDisplayName(option: PythonEnvironmentOption): string {
  return `Python 3 (${option.label})`;
}

async function selectPythonInterpreter(
  folderPath: string,
  parentWindow: BrowserWindow | null
): Promise<FolderEnvironmentResult> {
  let resolvedFolder: string;
  try {
    resolvedFolder = normalizeFolderPath(folderPath);
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }

  const dialogOptions: Electron.OpenDialogOptions = {
    title: 'Select Python Interpreter',
    defaultPath: resolvedFolder,
    properties: ['openFile']
  };
  const result =
    parentWindow === null
      ? await dialog.showOpenDialog(dialogOptions)
      : await dialog.showOpenDialog(parentWindow, dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return prepareFolder(resolvedFolder);
  }

  try {
    const pythonPath = path.resolve(result.filePaths[0]);
    const inspectedOption = inspectPythonEnvironment(
      resolvedFolder,
      pythonPath,
      'custom'
    );
    const discoveredEnvironments =
      discoverFolderPythonEnvironments(resolvedFolder);
    const selectedOption =
      discoveredEnvironments.find(
        option => option.pythonPath === inspectedOption.pythonPath
      ) ?? inspectedOption;
    const environments =
      selectedOption === inspectedOption
        ? [...discoveredEnvironments, inspectedOption]
        : discoveredEnvironments;

    return {
      ok: true,
      folderPath: resolvedFolder,
      environments,
      selectedPythonPath: selectedOption.pythonPath
    };
  } catch (error) {
    return {
      ok: false,
      folderPath: resolvedFolder,
      error: formatError(error)
    };
  }
}

function getManagedEnvironment(): ManagedEnvironment {
  const envDir = getManagedEnvironmentDir();
  const binDir = getManagedEnvironmentBinDir(envDir);
  const pythonPath = getManagedEnvironmentExecutablePath(envDir, 'python');
  const xtralabPath = getManagedEnvironmentExecutablePath(envDir, 'xtralab');

  if (!existsSync(xtralabPath)) {
    throw new Error(
      `Bundled Python runtime is missing at ${envDir}. Run "pnpm build:runtime" before launching.`
    );
  }

  ensureRuntimePyvenvCfg(envDir, binDir);

  return { envDir, binDir, pythonPath, xtralabPath };
}

function ensureRuntimePyvenvCfg(envDir: string, binDir: string): void {
  // The bundled runtime is a uv-installed Python (not a venv), but we set
  // VIRTUAL_ENV=<envDir> for child processes. Tools like Astral ty refuse to
  // start without a pyvenv.cfg, so synthesize a self-referential one. Python's
  // own startup is unaffected because sys.prefix and sys.base_prefix both
  // resolve back to envDir.
  // Upstream tracking: https://github.com/astral-sh/ty/issues/2794 — revisit
  // and drop this shim once ty accepts a missing/broken pyvenv.cfg or honors
  // an explicit interpreter override for `ty server`.
  const cfgPath = path.join(envDir, 'pyvenv.cfg');
  const desiredHomeLine = `home = ${binDir}`;
  if (existsSync(cfgPath)) {
    try {
      const current = readFileSync(cfgPath, 'utf8');
      if (current.includes(desiredHomeLine)) {
        return;
      }
    } catch {
      // fall through and rewrite
    }
  }

  const libDir = path.join(envDir, 'lib');
  let versionInfo = '3';
  if (existsSync(libDir)) {
    const versionEntry = readdirSync(libDir).find(name =>
      /^python\d+\.\d+$/.test(name)
    );
    if (versionEntry !== undefined) {
      versionInfo = versionEntry.replace(/^python/, '');
    }
  }

  const contents =
    `${desiredHomeLine}\n` +
    'implementation = CPython\n' +
    `version_info = ${versionInfo}\n` +
    'include-system-site-packages = false\n';
  writeFileSync(cfgPath, contents, 'utf8');
}

function getSupervisorEnvironment(
  managedEnvironment: ManagedEnvironment,
  projectEnvironment: ProjectRuntimeEnvironment | null
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: composeRuntimePath(managedEnvironment.binDir),
    PYTHONNOUSERSITE: '1'
  };
  clearInheritedPythonEnvironment(environment);
  environment.VIRTUAL_ENV = managedEnvironment.envDir;

  // Advertise an iTerm2-class terminal so coding agents (Claude Code, Codex, …)
  // take their OSC 9 notification path on the default `auto` setting; without a
  // recognized TERM_PROGRAM they emit nothing. The renderer intercepts the OSC 9
  // and forwards it to the OS. TERM stays xterm-256color (what real iTerm2 uses).
  environment.TERM_PROGRAM = 'iTerm.app';
  environment.TERM_PROGRAM_VERSION = '3.5.0';

  const jupyterStateRoot = path.join(app.getPath('userData'), 'jupyter');
  const jupyterDataDir = path.join(jupyterStateRoot, 'data');
  const jupyterConfigDir = path.join(jupyterStateRoot, 'config');
  const jupyterRuntimeDir = getJupyterRuntimeDir();
  mkdirSync(jupyterDataDir, { recursive: true });
  mkdirSync(jupyterConfigDir, { recursive: true });
  mkdirSync(jupyterRuntimeDir, { recursive: true });
  environment.JUPYTER_DATA_DIR = jupyterDataDir;
  environment.JUPYTER_CONFIG_DIR = jupyterConfigDir;
  environment.JUPYTER_RUNTIME_DIR = jupyterRuntimeDir;

  delete environment.JUPYTER_PATH;
  if (projectEnvironment !== null) {
    environment.JUPYTER_PATH = projectEnvironment.kernelDataPath;
  }

  return environment;
}

function startSupervisor(
  folderPath: string,
  managedEnvironment: ManagedEnvironment,
  projectEnvironment: ProjectRuntimeEnvironment | null
): SupervisorHandle {
  const command = managedEnvironment.xtralabPath;
  const collabDir = getProjectCollabDir(folderPath);
  mkdirSync(collabDir, { recursive: true });
  const args = [
    'serve',
    '--json',
    '--timeout',
    '120',
    '--cwd',
    folderPath,
    '--collab-ystore-db',
    path.join(collabDir, 'ystore.db'),
    '--workspace',
    getProjectWorkspaceName(folderPath)
  ];

  log(`Starting supervisor: ${command} ${args.join(' ')}`);
  log(`Supervisor cwd: ${folderPath}`);
  log(`Supervisor Python environment: ${managedEnvironment.envDir}`);
  if (projectEnvironment !== null) {
    log(`Project Python environment: ${projectEnvironment.option.pythonPath}`);
  }

  const child = spawn(command, args, {
    cwd: folderPath,
    env: getSupervisorEnvironment(managedEnvironment, projectEnvironment),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdoutBuffer = '';
  let stderrTail = '';
  let readySettled = false;
  let readyTimer: NodeJS.Timeout;

  const exited = new Promise<SupervisorExitInfo>(resolve => {
    child.once('exit', (code, signal) => {
      log(
        `Supervisor exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`
      );
      resolve({ code, signal, stderrTail });
    });
  });

  const ready = new Promise<ServerInfo>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      clearTimeout(readyTimer);
      reject(error);
    };

    readyTimer = setTimeout(() => {
      fail(
        new Error('Timed out waiting for xtralab serve --json to become ready')
      );
    }, 180000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const parts = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = parts.pop() ?? '';

      for (const line of parts) {
        let serverInfo: ServerInfo | null;
        try {
          serverInfo = parseReadyLine(line);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(formatError(error)));
          continue;
        }

        if (serverInfo === null) {
          if (line.trim().length > 0) {
            log(`supervisor stdout: ${line}`);
          }
          continue;
        }

        if (!readySettled) {
          readySettled = true;
          clearTimeout(readyTimer);
          log(`Supervisor ready at ${serverInfo.baseUrl}`);
          resolve(serverInfo);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = `${stderrTail}${text}`.slice(-8000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          log(`supervisor stderr: ${line}`);
        }
      }
    });

    child.on('error', error => {
      fail(
        new Error(
          `Unable to start supervisor command "${command}": ${error.message}`
        )
      );
    });

    void exited.then(info => {
      if (!readySettled) {
        fail(
          new Error(
            `Supervisor exited before it was ready. ${info.stderrTail.trim() || 'No stderr output was captured.'}`
          )
        );
      }
    });
  });

  return {
    process: child,
    ready,
    exited,
    stop: () => stopSupervisor(child)
  };
}

function createLabWindow(
  serverInfo: ServerInfo,
  folderPath: string,
  supervisor: SupervisorHandle,
  projectEnvironment: ProjectRuntimeEnvironment | null,
  sourceLauncher: BrowserWindow | null,
  attachAsTab: boolean
): void {
  const allowedOrigin = new URL(serverInfo.baseUrl).origin;
  const windowTitle = getLabWindowTitle(folderPath);

  const window = new BrowserWindow({
    title: windowTitle,
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#111111',
    icon: getPngIconPath(),
    tabbingIdentifier: labWindowTabbingIdentifier,
    webPreferences: {
      preload: getLabPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    }
  });

  labSessions.set(window.id, {
    folderPath,
    projectEnvironment,
    supervisor,
    window
  });

  let windowEverShown = false;
  let sessionAborted = false;

  const abortSession = (reason: string): void => {
    if (sessionAborted) {
      return;
    }
    sessionAborted = true;
    log(`Aborting lab session for ${folderPath}: ${reason}`);

    const wasShown = windowEverShown;
    if (!window.isDestroyed()) {
      window.destroy();
    }
    labSessions.delete(window.id);

    if (!quitInProgress) {
      void supervisor.stop();
    }

    if (!wasShown && !quitInProgress) {
      const folderName = path.basename(folderPath) || folderPath;
      dialog.showErrorBox(
        `${app.getName()} - ${folderName}`,
        `${reason}\n\nCheck Help → Show Logs for details.`
      );
      // A failed open leaves the source launcher disabled in its
      // "Opening..." state (it only closes once the lab window shows), so
      // reload it back to a usable welcome view.
      if (sourceLauncher !== null && !sourceLauncher.isDestroyed()) {
        sourceLauncher.webContents.reload();
      }
      showLauncherWindow();
    }
  };

  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => {
      callback(false);
    }
  );

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedLocalUrl(url, allowedOrigin)) {
      void window.loadURL(url);
    } else {
      openExternalIfSafe(url, allowedOrigin);
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedLocalUrl(url, allowedOrigin)) {
      return;
    }

    event.preventDefault();
    openExternalIfSafe(url, allowedOrigin);
  });

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (code === -3) {
      return;
    }
    log(`Window failed to load ${url}: ${code} ${description}`);
    if (!windowEverShown) {
      abortSession(
        `Unable to load the Jupyter lab page: ${description || `error ${code}`}.`
      );
    }
  });

  window.webContents.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle(windowTitle);
  });

  window.once('ready-to-show', () => {
    windowEverShown = true;
    // The launcher stays visible in its "Opening..." state while the server
    // starts and the page loads, and is only swapped for the lab window once
    // there is something to show. When the launcher is a tab, the lab window
    // joins its tab group first so the new tab takes the launcher tab's
    // place.
    const launcherToClose =
      sourceLauncher !== null &&
      sourceLauncher === launcherWindow &&
      !sourceLauncher.isDestroyed()
        ? sourceLauncher
        : null;
    if (attachAsTab && launcherToClose !== null) {
      attachWindowAsTab(launcherToClose, window);
    }
    window.show();
    launcherToClose?.close();
  });

  // The native macOS "+" in the tab bar opens the launcher as a tab in this
  // window's tab group, ready to pick a folder. The button appears because
  // the window sets a tabbingIdentifier; AppKit expects this handler to open
  // a window.
  window.on('new-window-for-tab', () => {
    openLauncherTab(window);
  });

  window.on('closed', () => {
    sessionAborted = true;
    const session = labSessions.get(window.id);
    labSessions.delete(window.id);
    notificationTimestamps.delete(window.id);
    if (session !== undefined && !quitInProgress) {
      void session.supervisor.stop();
    }
  });

  void supervisor.exited.then(info => {
    if (sessionAborted) {
      return;
    }
    abortSession(
      `The Jupyter server stopped unexpectedly (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'}).`
    );
  });

  void window.loadURL(serverInfo.url);
}

function parseReadyLine(line: string): ServerInfo | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isServerInfo(parsed)) {
    return null;
  }

  validateServerInfo(parsed);
  return parsed;
}

function isServerInfo(value: unknown): value is ServerInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<ServerInfo>;
  return (
    typeof candidate.url === 'string' &&
    typeof candidate.baseUrl === 'string' &&
    typeof candidate.token === 'string'
  );
}

function validateServerInfo(serverInfo: ServerInfo): void {
  const appUrl = new URL(serverInfo.url);
  const baseUrl = new URL(serverInfo.baseUrl);

  if (
    appUrl.protocol !== 'http:' ||
    baseUrl.protocol !== 'http:' ||
    appUrl.hostname !== '127.0.0.1' ||
    baseUrl.hostname !== '127.0.0.1' ||
    appUrl.origin !== baseUrl.origin
  ) {
    throw new Error(
      `Supervisor returned a non-loopback URL: ${serverInfo.url}`
    );
  }
}

function isAllowedLocalUrl(
  rawUrl: string,
  allowedOrigin: string | null
): boolean {
  if (allowedOrigin === null) {
    return false;
  }

  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.origin === allowedOrigin
    );
  } catch {
    return false;
  }
}

function openExternalIfSafe(
  rawUrl: string,
  allowedOrigin: string | null
): void {
  if (isAllowedLocalUrl(rawUrl, allowedOrigin)) {
    return;
  }

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol === 'http:' ||
      url.protocol === 'https:' ||
      url.protocol === 'mailto:'
    ) {
      void shell.openExternal(url.toString());
    }
  } catch (error) {
    log(`Blocked invalid external URL "${rawUrl}": ${formatError(error)}`);
  }
}

async function shutdownAndQuit(): Promise<void> {
  if (quitInProgress) {
    return;
  }

  quitInProgress = true;
  for (const session of labSessions.values()) {
    if (!session.window.isDestroyed()) {
      session.window.hide();
    }
  }

  await Promise.all([
    ...[...labSessions.values()].map(session => session.supervisor.stop()),
    ...[...pendingSupervisors].map(supervisor => supervisor.stop())
  ]);
  labSessions.clear();
  pendingSupervisors.clear();

  app.quit();
}

function stopSupervisor(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let terminateTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (terminateTimer !== null) {
        clearTimeout(terminateTimer);
      }
      if (killTimer !== null) {
        clearTimeout(killTimer);
      }
      resolve();
    };

    child.once('exit', cleanup);

    try {
      child.stdin.end();
      log('Requested supervisor shutdown by closing stdin');
    } catch (error) {
      log(`Unable to close supervisor stdin: ${formatError(error)}`);
    }

    terminateTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      log('Supervisor did not exit after stdin close; sending SIGTERM');
      child.kill('SIGTERM');

      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          log('Supervisor did not exit after SIGTERM; sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, 5000);
    }, 10000);
  });
}

function loadRecentFolders(): void {
  try {
    const raw = readFileSync(getRecentFoldersPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      recentFolders = [];
      return;
    }
    recentFolders = parsed.filter(
      (folder): folder is string =>
        typeof folder === 'string' && isDirectory(folder)
    );
  } catch {
    recentFolders = [];
  }
}

function saveRecentFolders(): void {
  try {
    writeFileSync(
      getRecentFoldersPath(),
      `${JSON.stringify(recentFolders, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    log(`Unable to save recent folders: ${formatError(error)}`);
  }
}

function getRecentFolders(): string[] {
  recentFolders = recentFolders.filter(folderPath => isDirectory(folderPath));
  saveRecentFolders();
  return recentFolders;
}

function rememberRecentFolder(folderPath: string): void {
  recentFolders = [
    folderPath,
    ...recentFolders.filter(recentFolder => recentFolder !== folderPath)
  ].slice(0, recentFoldersLimit);
  saveRecentFolders();
}

function forgetRecentFolder(folderPath: string): string[] {
  recentFolders = recentFolders.filter(
    recentFolder => recentFolder !== folderPath
  );
  return getRecentFolders();
}

function clearRecentFolders(): string[] {
  recentFolders = [];
  saveRecentFolders();
  return recentFolders;
}

function loadFolderEnvironmentPreferences(): void {
  try {
    const raw = readFileSync(getFolderEnvironmentPreferencesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      folderEnvironmentPreferences = {};
      return;
    }

    folderEnvironmentPreferences = {};
    for (const [folderPath, preference] of Object.entries(parsed)) {
      if (
        typeof folderPath !== 'string' ||
        typeof preference !== 'object' ||
        preference === null
      ) {
        continue;
      }

      const candidate = preference as Partial<FolderEnvironmentPreference>;
      if (
        (typeof candidate.pythonPath === 'string' ||
          candidate.pythonPath === null) &&
        typeof candidate.updatedAt === 'string'
      ) {
        folderEnvironmentPreferences[folderPath] = {
          pythonPath: candidate.pythonPath,
          updatedAt: candidate.updatedAt
        };
      }
    }
  } catch {
    folderEnvironmentPreferences = {};
  }
}

function saveFolderEnvironmentPreferences(): void {
  try {
    writeFileSync(
      getFolderEnvironmentPreferencesPath(),
      `${JSON.stringify(folderEnvironmentPreferences, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    log(`Unable to save folder environment preferences: ${formatError(error)}`);
  }
}

function rememberFolderEnvironmentPreference(
  folderPath: string,
  pythonPath: string | null
): void {
  folderEnvironmentPreferences[folderPath] = {
    pythonPath,
    updatedAt: new Date().toISOString()
  };
  saveFolderEnvironmentPreferences();
}

function normalizeFolderPath(folderPath: string): string {
  const resolved = path.resolve(folderPath);
  if (!isDirectory(resolved)) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

function isDirectory(folderPath: string): boolean {
  try {
    return statSync(folderPath).isDirectory();
  } catch {
    return false;
  }
}

function getLabWindowTitle(folderPath: string): string {
  const folderName = path.basename(folderPath) || folderPath;
  return `${folderName} - ${app.getName()}`;
}

function getManagedEnvironmentDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.join(getDesktopRoot(), 'python', 'runtime');
}

function getManagedEnvironmentBinDir(envDir: string): string {
  return path.join(envDir, process.platform === 'win32' ? 'Scripts' : 'bin');
}

function getManagedEnvironmentExecutablePath(
  envDir: string,
  executableName: string
): string {
  const platformExecutableName =
    process.platform === 'win32' ? `${executableName}.exe` : executableName;
  return path.join(getManagedEnvironmentBinDir(envDir), platformExecutableName);
}

// A short, stable identifier for one opened folder, derived from its absolute
// path. Keys the per-folder state xtralab keeps under app data (kernels,
// collaboration history, JupyterLab workspace) so two folders never collide
// and the same folder maps back to its own state on every launch.
function getProjectHash(folderPath: string): string {
  return createHash('sha256').update(folderPath).digest('hex').slice(0, 16);
}

function getProjectKernelDataPath(folderPath: string): string {
  return path.join(
    app.getPath('userData'),
    'project-kernels',
    getProjectHash(folderPath)
  );
}

// Per-folder collaboration state directory. jupyter-server-ydoc creates two
// files alongside whichever folder the user opens (.jupyter_ystore.db and
// .jupyter/collaboration_sessions.json). We relocate them under userData so
// they don't pollute the user's project (and don't show up as untracked in
// git). The directory is keyed by a hash of the folder path so each opened
// folder gets its own isolated Y-history and session set.
function getProjectCollabDir(folderPath: string): string {
  return path.join(
    app.getPath('userData'),
    'jupyter',
    'collab',
    getProjectHash(folderPath)
  );
}

// The JupyterLab workspace name for one folder. JupyterLab persists each
// window's open tabs and panel layout into a server-side workspace; loading a
// folder as `/lab/workspaces/<name>` keeps that layout in its own file rather
// than the `default` workspace every window would otherwise share, where one
// folder restores another's tabs. The folder hash makes the name unique and
// stable across launches; the readable slug only aids debugging. The lowercase
// slug and hex hash satisfy jupyterlab_server's `[A-Za-z0-9_-]` workspace route.
function getProjectWorkspaceName(folderPath: string): string {
  const slug = path
    .basename(folderPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = getProjectHash(folderPath);
  return slug ? `${slug}-${hash}` : hash;
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(
    path.resolve(parentPath),
    path.resolve(childPath)
  );
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function getDesktopRoot(): string {
  return path.resolve(__dirname, '..');
}

function getLauncherHtmlPath(): string {
  return path.join(getDesktopRoot(), 'src', 'launcher.html');
}

function getPreloadPath(): string {
  return path.join(__dirname, 'preload.js');
}

function getLabPreloadPath(): string {
  return path.join(__dirname, 'preload-lab.js');
}

function getPngIconPath(): string {
  return path.join(getDesktopRoot(), 'assets', 'jupyter.png');
}

function getLogsDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function getJupyterRuntimeDir(): string {
  return path.join(app.getPath('userData'), 'jupyter', 'runtime');
}

function cleanupStaleJupyterServers(): void {
  const runtimeDir = getJupyterRuntimeDir();
  let entries: string[];
  try {
    entries = readdirSync(runtimeDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith('jpserver-') || !entry.endsWith('.json')) {
      continue;
    }
    const entryPath = path.join(runtimeDir, entry);

    let pid: number | null = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(entryPath, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { pid?: unknown }).pid === 'number'
      ) {
        pid = (parsed as { pid: number }).pid;
      }
    } catch {
      // Unreadable or corrupt file - just delete it below.
    }

    if (pid !== null && pid > 0 && looksLikeOurJupyterProcess(pid)) {
      log(`Terminating orphaned Jupyter server pid ${pid} from ${entry}`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        log(`Unable to SIGTERM pid ${pid}: ${formatError(error)}`);
      }
    }

    try {
      rmSync(entryPath, { force: true });
    } catch (error) {
      log(`Unable to remove stale ${entry}: ${formatError(error)}`);
    }
  }
}

function looksLikeOurJupyterProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform === 'win32') {
    return false;
  }

  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 1000
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return false;
  }

  return /jupyter|xtralab/i.test(result.stdout);
}

function getRecentFoldersPath(): string {
  return path.join(app.getPath('userData'), 'recent-folders.json');
}

function getFolderEnvironmentPreferencesPath(): string {
  return path.join(app.getPath('userData'), 'folder-environments.json');
}

function showStartupError(error: unknown): void {
  dialog.showErrorBox(`${app.getName()} failed to start`, formatError(error));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
