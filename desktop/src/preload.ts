import { contextBridge, ipcRenderer } from 'electron';

interface OpenFolderResult {
  ok: boolean;
  folderPath?: string;
  error?: string;
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

type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error';

interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  error: string | null;
}

type RestoreProjectStatus = 'starting' | 'ready' | 'opened' | 'failed';

interface RestoreProjectState {
  folderPath: string;
  status: RestoreProjectStatus;
  error: string | null;
}

interface RestoreProgressState {
  restoring: boolean;
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
