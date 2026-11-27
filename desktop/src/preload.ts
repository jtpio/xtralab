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
  openFolderDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('xtralab:open-folder-dialog'),
  openFolder: (folderPath: string): Promise<OpenFolderResult> =>
    ipcRenderer.invoke('xtralab:open-folder', folderPath),
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
