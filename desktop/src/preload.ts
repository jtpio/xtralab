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

contextBridge.exposeInMainWorld('xtralab', {
  getHomeDir: (): Promise<string> => ipcRenderer.invoke('xtralab:get-home-dir'),
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
  showLogs: (): Promise<void> => ipcRenderer.invoke('xtralab:show-logs')
});
