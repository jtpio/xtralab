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
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron';

interface ServerInfo {
  url: string;
  baseUrl: string;
  token: string;
}

interface SupervisorHandle {
  process: ChildProcessWithoutNullStreams;
  ready: Promise<ServerInfo>;
  stop: () => Promise<void>;
}

interface ManagedEnvironment {
  envDir: string;
  binDir: string;
  pythonPath: string;
  xtralabPath: string;
  wheelName: string;
}

interface WheelFingerprint {
  wheelName: string;
  wheelSize: number;
  wheelSha256: string;
}

interface RunCommandOptions {
  label: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface LabSession {
  folderPath: string;
  supervisor: SupervisorHandle;
  window: BrowserWindow;
}

interface OpenFolderResult {
  ok: boolean;
  folderPath?: string;
  error?: string;
}

const recentFoldersLimit = 8;
const labSessions = new Map<number, LabSession>();
const pendingSupervisors = new Set<SupervisorHandle>();

let launcherWindow: BrowserWindow | null = null;
let logStream: WriteStream | null = null;
let recentFolders: string[] = [];
let quitInProgress = false;
let ipcRegistered = false;
let managedEnvironmentPromise: Promise<ManagedEnvironment> | null = null;

app.setName('Xtralab');

app
  .whenReady()
  .then(startApplication)
  .catch(error => {
    showStartupError(error);
    app.quit();
  });

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

async function startApplication(): Promise<void> {
  initializeLogging();
  configureApplicationMenu();
  prepareProcessEnvironment();
  setApplicationIcon();
  loadRecentFolders();
  registerIpcHandlers();
  showLauncherWindow();
}

function initializeLogging(): void {
  const logsDir = path.join(app.getPath('userData'), 'logs');
  mkdirSync(logsDir, { recursive: true });
  logStream = createWriteStream(path.join(logsDir, 'main.log'), {
    flags: 'a'
  });
  log('Starting Xtralab desktop');
}

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  logStream?.write(`${line}\n`);
  console.log(line);
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'Xtralab',
            submenu: [
              { role: 'about', label: 'About Xtralab' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: 'Hide Xtralab' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: 'Quit Xtralab' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void openFolderFromDialog();
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
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu:
        process.platform === 'darwin'
          ? [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }]
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
  const pathCandidates = [
    removeActivePythonEnvironmentPath(process.env.PATH),
    process.env.XTRALAB_EXTRA_PATH,
    getExternalCommandPath()
  ];

  const mergedPath = mergePathSegments(pathCandidates);
  if (mergedPath.length === 0) {
    log('Unable to prepare a usable process PATH');
    return;
  }

  process.env.PATH = mergedPath;
  log('Prepared process PATH for app-managed Python and external tools');
  logAgentCommandAvailability();
}

function getExternalCommandPath(): string {
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

function clearInheritedPythonEnvironment(
  environment: NodeJS.ProcessEnv
): void {
  delete environment.CONDA_DEFAULT_ENV;
  delete environment.CONDA_PREFIX;
  delete environment.CONDA_PROMPT_MODIFIER;
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  delete environment.UV_PROJECT_ENVIRONMENT;
  delete environment.VIRTUAL_ENV;
  delete environment.VIRTUAL_ENV_PROMPT;
}

function logAgentCommandAvailability(): void {
  const commands = [
    'claude',
    'codex',
    'gemini',
    'copilot',
    'goose',
    'opencode',
    'kiro',
    'vibe'
  ];
  const result = spawnSync(
    '/bin/sh',
    ['-c', commands.map(command => `command -v ${command} || true`).join('\n')],
    {
      encoding: 'utf8',
      env: process.env,
      timeout: 5000
    }
  );

  const resolved = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  log(
    `Agent command PATH probe: ${resolved.length ? resolved.join(', ') : 'none'}`
  );
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

  ipcMain.handle('xtralab:get-recent-folders', () => getRecentFolders());
  ipcMain.handle('xtralab:show-logs', async () => {
    await shell.openPath(getLogsDir());
  });
  ipcMain.handle('xtralab:open-folder-dialog', async event => {
    return openFolderFromDialog(BrowserWindow.fromWebContents(event.sender));
  });
  ipcMain.handle(
    'xtralab:open-recent-folder',
    async (event: IpcMainInvokeEvent, folderPath: unknown) => {
      if (typeof folderPath !== 'string') {
        return {
          ok: false,
          error: 'Invalid folder path'
        } satisfies OpenFolderResult;
      }
      return openFolder(
        folderPath,
        BrowserWindow.fromWebContents(event.sender)
      );
    }
  );
}

function showLauncherWindow(): void {
  if (launcherWindow !== null && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    launcherWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    title: 'Xtralab',
    width: 680,
    height: 560,
    minWidth: 560,
    minHeight: 440,
    show: false,
    backgroundColor: '#f6f6f4',
    icon: getPngIconPath(),
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: false
    }
  });

  launcherWindow = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url, null);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => {
    event.preventDefault();
  });
  window.webContents.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle('Xtralab');
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  window.on('closed', () => {
    if (launcherWindow === window) {
      launcherWindow = null;
    }
  });

  void window.loadFile(getLauncherHtmlPath());
}

async function openFolderFromDialog(
  parentWindow: BrowserWindow | null = launcherWindow
): Promise<OpenFolderResult> {
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

  return openFolder(result.filePaths[0], parentWindow);
}

async function openFolder(
  folderPath: string,
  sourceWindow: BrowserWindow | null = launcherWindow
): Promise<OpenFolderResult> {
  let resolvedFolder: string;
  try {
    resolvedFolder = normalizeFolderPath(folderPath);
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }

  try {
    await createLabSession(resolvedFolder);
    rememberRecentFolder(resolvedFolder);
    if (
      sourceWindow !== null &&
      sourceWindow === launcherWindow &&
      !sourceWindow.isDestroyed()
    ) {
      sourceWindow.close();
    }
    return { ok: true, folderPath: resolvedFolder };
  } catch (error) {
    log(`Unable to open ${resolvedFolder}: ${formatError(error)}`);
    return { ok: false, folderPath: resolvedFolder, error: formatError(error) };
  }
}

async function createLabSession(folderPath: string): Promise<void> {
  const managedEnvironment = await getManagedEnvironment();
  const supervisor = startSupervisor(folderPath, managedEnvironment);
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
  createLabWindow(serverInfo, folderPath, supervisor);
}

async function getManagedEnvironment(): Promise<ManagedEnvironment> {
  if (managedEnvironmentPromise === null) {
    managedEnvironmentPromise = bootstrapManagedEnvironment().catch(error => {
      managedEnvironmentPromise = null;
      throw error;
    });
  }

  return managedEnvironmentPromise;
}

async function bootstrapManagedEnvironment(): Promise<ManagedEnvironment> {
  const envDir = getManagedEnvironmentDir();
  const binDir = getManagedEnvironmentBinDir(envDir);
  const pythonPath = getManagedEnvironmentExecutablePath(envDir, 'python');
  const xtralabPath = getManagedEnvironmentExecutablePath(envDir, 'xtralab');
  const bundledWheelPath = getBundledWheelSourcePath();
  const wheelPath = copyBundledWheelToPackageCache(bundledWheelPath);
  const wheelFingerprint = getWheelFingerprint(wheelPath);
  const markerPath = getManagedEnvironmentMarkerPath(envDir);
  const environment: ManagedEnvironment = {
    envDir,
    binDir,
    pythonPath,
    xtralabPath,
    wheelName: wheelFingerprint.wheelName
  };

  if (isManagedEnvironmentCurrent(environment, markerPath, wheelFingerprint)) {
    log(
      `Using managed Python environment ${envDir} with ${wheelFingerprint.wheelName}`
    );
    return environment;
  }

  log(`Preparing managed Python environment at ${envDir}`);
  mkdirSync(path.dirname(envDir), { recursive: true });

  if (!existsSync(pythonPath)) {
    await runCommand(getUvCommand(), getUvVenvArgs(envDir), {
      label: 'uv venv',
      env: getBootstrapEnvironment(),
      timeoutMs: 600000
    });
  }

  if (!existsSync(pythonPath)) {
    throw new Error(`Managed Python executable was not created: ${pythonPath}`);
  }

  await runCommand(
    getUvCommand(),
    [
      'pip',
      'install',
      '--python',
      pythonPath,
      '--upgrade',
      '--reinstall',
      '--prerelease',
      'allow',
      wheelPath
    ],
    {
      label: 'uv pip install',
      env: getBootstrapEnvironment(),
      timeoutMs: 900000
    }
  );

  if (!existsSync(xtralabPath)) {
    throw new Error(`Xtralab executable was not installed: ${xtralabPath}`);
  }

  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        ...wheelFingerprint,
        installedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  log(
    `Managed Python environment is ready at ${envDir} with ${wheelFingerprint.wheelName}`
  );

  return environment;
}

function isManagedEnvironmentCurrent(
  environment: ManagedEnvironment,
  markerPath: string,
  wheelFingerprint: WheelFingerprint
): boolean {
  if (!existsSync(environment.pythonPath) || !existsSync(environment.xtralabPath)) {
    return false;
  }

  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<
      WheelFingerprint
    >;
    return (
      marker.wheelName === wheelFingerprint.wheelName &&
      marker.wheelSize === wheelFingerprint.wheelSize &&
      marker.wheelSha256 === wheelFingerprint.wheelSha256
    );
  } catch {
    return false;
  }
}

function getUvCommand(): string {
  return process.env.XTRALAB_UV_PATH || 'uv';
}

function getUvVenvArgs(envDir: string): string[] {
  const args = ['venv'];
  if (process.env.XTRALAB_PYTHON !== undefined) {
    args.push('--python', process.env.XTRALAB_PYTHON);
  }
  args.push(envDir);
  return args;
}

function getBootstrapEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: mergePathSegments([
      removeActivePythonEnvironmentPath(process.env.PATH),
      getExternalCommandPath()
    ]),
    PYTHONNOUSERSITE: '1'
  };

  clearInheritedPythonEnvironment(environment);

  return environment;
}

function getSupervisorEnvironment(
  managedEnvironment: ManagedEnvironment
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: mergePathSegments([
      managedEnvironment.binDir,
      removeActivePythonEnvironmentPath(process.env.PATH),
      getExternalCommandPath()
    ]),
    PYTHONNOUSERSITE: '1',
    VIRTUAL_ENV: managedEnvironment.envDir
  };

  delete environment.CONDA_DEFAULT_ENV;
  delete environment.CONDA_PREFIX;
  delete environment.CONDA_PROMPT_MODIFIER;
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  delete environment.UV_PROJECT_ENVIRONMENT;
  delete environment.VIRTUAL_ENV_PROMPT;

  return environment;
}

function getBundledWheelSourcePath(): string {
  const wheelsDir = path.join(getDesktopRoot(), 'python', 'wheels');
  let wheels: Array<{ name: string; path: string; mtimeMs: number }>;

  try {
    wheels = readdirSync(wheelsDir)
      .filter(name => name.startsWith('xtralab-') && name.endsWith('.whl'))
      .map(name => {
        const wheelPath = path.join(wheelsDir, name);
        return {
          name,
          path: wheelPath,
          mtimeMs: statSync(wheelPath).mtimeMs
        };
      });
  } catch (error) {
    throw new Error(
      `Unable to read bundled Python wheels from ${wheelsDir}. Run "npm run build:python" in desktop before launching. ${formatError(error)}`
    );
  }

  wheels.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }
    return right.name.localeCompare(left.name);
  });

  if (wheels.length === 0) {
    throw new Error(
      `No bundled Xtralab wheel found in ${wheelsDir}. Run "npm run build:python" in desktop before launching.`
    );
  }

  return wheels[0].path;
}

function copyBundledWheelToPackageCache(sourcePath: string): string {
  const packagesDir = path.join(app.getPath('userData'), 'packages');
  const targetPath = path.join(packagesDir, path.basename(sourcePath));
  const sourceContents = readFileSync(sourcePath);

  mkdirSync(packagesDir, { recursive: true });
  writeFileSync(targetPath, sourceContents);

  return targetPath;
}

function getWheelFingerprint(wheelPath: string): WheelFingerprint {
  const contents = readFileSync(wheelPath);
  return {
    wheelName: path.basename(wheelPath),
    wheelSize: contents.byteLength,
    wheelSha256: createHash('sha256').update(contents).digest('hex')
  };
}

function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions
): Promise<void> {
  log(`${options.label}: ${command} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let outputTail = '';
    let timer: NodeJS.Timeout | null = null;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    };

    const appendOutput = (streamName: string, chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      outputTail = `${outputTail}${text}`.slice(-8000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          log(`${options.label} ${streamName}: ${line}`);
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      appendOutput('stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendOutput('stderr', chunk);
    });
    child.on('error', error => {
      finish(
        new Error(
          `Unable to start ${options.label} command "${command}": ${error.message}`
        )
      );
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `${options.label} failed with code ${code ?? 'null'} and signal ${signal ?? 'null'}. ${outputTail.trim()}`
        )
      );
    });

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(
        new Error(`${options.label} timed out after ${options.timeoutMs}ms`)
      );
    }, options.timeoutMs);
  });
}

function startSupervisor(
  folderPath: string,
  managedEnvironment: ManagedEnvironment
): SupervisorHandle {
  const command = managedEnvironment.xtralabPath;
  const args = [
    'serve',
    '--json',
    '--timeout',
    '120',
    '--cwd',
    folderPath
  ];

  log(`Starting supervisor: ${command} ${args.join(' ')}`);
  log(`Supervisor cwd: ${folderPath}`);
  log(`Supervisor Python environment: ${managedEnvironment.envDir}`);

  const child = spawn(command, args, {
    cwd: folderPath,
    env: getSupervisorEnvironment(managedEnvironment),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdoutBuffer = '';
  let stderrTail = '';
  let readySettled = false;
  let readyTimer: NodeJS.Timeout;

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

    child.on('exit', (code, signal) => {
      log(
        `Supervisor exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`
      );
      if (!readySettled) {
        fail(
          new Error(
            `Supervisor exited before it was ready. ${stderrTail.trim() || 'No stderr output was captured.'}`
          )
        );
      }
    });
  });

  return {
    process: child,
    ready,
    stop: () => stopSupervisor(child)
  };
}

function createLabWindow(
  serverInfo: ServerInfo,
  folderPath: string,
  supervisor: SupervisorHandle
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    }
  });

  labSessions.set(window.id, {
    folderPath,
    supervisor,
    window
  });

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
    log(`Window failed to load ${url}: ${code} ${description}`);
  });

  window.webContents.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle(windowTitle);
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    const session = labSessions.get(window.id);
    labSessions.delete(window.id);
    if (session !== undefined && !quitInProgress) {
      void session.supervisor.stop();
    }
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
  return `${folderName} - Xtralab`;
}

function getManagedEnvironmentDir(): string {
  return path.join(app.getPath('userData'), 'envs', 'default');
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
  return path.join(
    getManagedEnvironmentBinDir(envDir),
    platformExecutableName
  );
}

function getManagedEnvironmentMarkerPath(envDir: string): string {
  return path.join(envDir, 'xtralab-install.json');
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

function getPngIconPath(): string {
  return path.join(getDesktopRoot(), 'assets', 'jupyter.png');
}

function getLogsDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function getRecentFoldersPath(): string {
  return path.join(app.getPath('userData'), 'recent-folders.json');
}

function showStartupError(error: unknown): void {
  dialog.showErrorBox('Xtralab failed to start', formatError(error));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
