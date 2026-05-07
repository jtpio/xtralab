import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

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
  dataPath: string | null;
  hasIpykernel: boolean;
  hasLabExtensions: boolean;
  hasKernels: boolean;
}

interface FolderEnvironmentResult {
  ok: boolean;
  folderPath?: string;
  environments?: PythonEnvironmentOption[];
  selectedPythonPath?: string | null;
  error?: string;
}

type BootstrapState =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'installing-deps' }
  | { kind: 'installing-xtralab' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

contextBridge.exposeInMainWorld('xtralab', {
  getRecentFolders: (): Promise<string[]> =>
    ipcRenderer.invoke('xtralab:get-recent-folders'),
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
  setLauncherContentHeight: (height: number): Promise<void> =>
    ipcRenderer.invoke('xtralab:set-launcher-content-height', height),
  showLogs: (): Promise<void> => ipcRenderer.invoke('xtralab:show-logs'),
  getBootstrapState: (): Promise<BootstrapState> =>
    ipcRenderer.invoke('xtralab:get-bootstrap-state'),
  retryBootstrap: (): Promise<void> =>
    ipcRenderer.invoke('xtralab:retry-bootstrap'),
  onBootstrapState: (callback: (state: BootstrapState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: BootstrapState): void => {
      callback(state);
    };
    ipcRenderer.on('xtralab:bootstrap-state', listener);
    return () => {
      ipcRenderer.off('xtralab:bootstrap-state', listener);
    };
  }
});
