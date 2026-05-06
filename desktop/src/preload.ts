import { contextBridge, ipcRenderer } from 'electron';

interface OpenFolderResult {
  ok: boolean;
  folderPath?: string;
  error?: string;
}

contextBridge.exposeInMainWorld('xtralab', {
  getRecentFolders: (): Promise<string[]> =>
    ipcRenderer.invoke('xtralab:get-recent-folders'),
  openFolder: (): Promise<OpenFolderResult> =>
    ipcRenderer.invoke('xtralab:open-folder-dialog'),
  openRecentFolder: (folderPath: string): Promise<OpenFolderResult> =>
    ipcRenderer.invoke('xtralab:open-recent-folder', folderPath),
  showLogs: (): Promise<void> => ipcRenderer.invoke('xtralab:show-logs')
});
