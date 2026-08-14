import { contextBridge, ipcRenderer } from 'electron';

/**
 * The result of a request to open a project folder.
 */
interface OpenFolderResult {
  /**
   * Whether the request succeeded.
   */
  ok: boolean;
  /**
   * The resolved absolute path of the folder, when available.
   */
  folderPath?: string;
  /**
   * A description of the failure, if any.
   */
  error?: string;
}

/**
 * A Python interpreter choice offered for a project folder.
 */
interface PythonEnvironmentOption {
  /**
   * The display name shown in the interpreter picker.
   */
  label: string;
  /**
   * The descriptive subtitle shown under the label, such as the
   * Python version and executable path.
   */
  detail: string;
  /**
   * The origin of the option: the bundled managed runtime, an
   * environment found in the project folder, or a user-picked interpreter.
   */
  kind: 'managed' | 'project' | 'custom';
  /**
   * The interpreter executable path, or null for the managed environment.
   */
  pythonPath: string | null;
  /**
   * The root directory of the Python environment, or null when unknown.
   */
  environmentRoot: string | null;
  /**
   * Whether ipykernel is importable in the environment.
   */
  hasIpykernel: boolean;
}

/**
 * The result of inspecting a folder's Python environments before opening it.
 */
interface FolderEnvironmentResult {
  /**
   * Whether the inspection succeeded.
   */
  ok: boolean;
  /**
   * The resolved absolute path of the folder, when available.
   */
  folderPath?: string;
  /**
   * The interpreter options discovered for the folder.
   */
  environments?: PythonEnvironmentOption[];
  /**
   * The interpreter to preselect; null selects the managed environment.
   */
  selectedPythonPath?: string | null;
  /**
   * A description of the failure, if any.
   */
  error?: string;
}

type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error';

/**
 * The application update state reported by the main process.
 */
interface UpdateState {
  /**
   * The current phase of the update flow.
   */
  status: UpdateStatus;
  /**
   * The version of the running application.
   */
  currentVersion: string;
  /**
   * The version available to install, or null when none is known.
   */
  latestVersion: string | null;
  /**
   * The last update error message, or null.
   */
  error: string | null;
}

type RestoreProjectStatus = 'starting' | 'ready' | 'opened' | 'failed';

/**
 * The restore status of one project during the startup session restore.
 */
interface RestoreProjectState {
  /**
   * The project folder being reopened.
   */
  folderPath: string;
  /**
   * The current phase of this project's restore.
   */
  status: RestoreProjectStatus;
  /**
   * The reason the restore failed, or null.
   */
  error: string | null;
}

/**
 * The progress of the startup session restore, shown in the launcher.
 */
interface RestoreProgressState {
  /**
   * Whether the restore is still running.
   */
  restoring: boolean;
  /**
   * The per-project restore states.
   */
  projects: RestoreProjectState[];
}

contextBridge.exposeInMainWorld('xtralab', {
  getHomeDir: (): Promise<string> => ipcRenderer.invoke('xtralab:get-home-dir'),
  getRecentFolders: (): Promise<string[]> =>
    ipcRenderer.invoke('xtralab:get-recent-folders'),
  forgetRecentFolder: (folderPath: string): Promise<string[]> =>
    ipcRenderer.invoke('xtralab:forget-recent-folder', folderPath),
  clearRecentFolders: (): Promise<string[]> =>
    ipcRenderer.invoke('xtralab:clear-recent-folders'),
  openFolderDialog: (): Promise<FolderEnvironmentResult> =>
    ipcRenderer.invoke('xtralab:open-folder-dialog'),
  prepareFolder: (folderPath: string): Promise<FolderEnvironmentResult> =>
    ipcRenderer.invoke('xtralab:prepare-folder', folderPath),
  openRecentFolder: (folderPath: string): Promise<FolderEnvironmentResult> =>
    ipcRenderer.invoke('xtralab:open-recent-folder', folderPath),
  selectPythonInterpreter: (
    folderPath: string
  ): Promise<FolderEnvironmentResult> =>
    ipcRenderer.invoke('xtralab:select-python-interpreter', folderPath),
  openFolder: (
    folderPath: string,
    pythonPath: string | null
  ): Promise<OpenFolderResult> =>
    ipcRenderer.invoke('xtralab:open-folder', folderPath, pythonPath),
  showLogs: (): Promise<void> => ipcRenderer.invoke('xtralab:show-logs'),
  getUpdateState: (): Promise<UpdateState> =>
    ipcRenderer.invoke('xtralab:get-update-state'),
  checkForUpdates: (): Promise<void> =>
    ipcRenderer.invoke('xtralab:check-for-updates'),
  downloadUpdate: (): Promise<void> =>
    ipcRenderer.invoke('xtralab:download-update'),
  restartToUpdate: (): Promise<void> =>
    ipcRenderer.invoke('xtralab:restart-to-update'),
  onUpdateState: (listener: (state: UpdateState) => void): void => {
    ipcRenderer.on('xtralab:update-state', (event, state: UpdateState) => {
      listener(state);
    });
  },
  getRestoreState: (): Promise<RestoreProgressState> =>
    ipcRenderer.invoke('xtralab:get-restore-state'),
  dismissRestoreResult: (): Promise<void> =>
    ipcRenderer.invoke('xtralab:dismiss-restore-result'),
  onRestoreState: (listener: (state: RestoreProgressState) => void): void => {
    ipcRenderer.on(
      'xtralab:restore-state',
      (event, state: RestoreProgressState) => {
        listener(state);
      }
    );
  }
});
