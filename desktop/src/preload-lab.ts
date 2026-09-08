import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('xtralab', {
  notify: (title: string, body: string, session?: string): Promise<void> =>
    ipcRenderer.invoke('xtralab:notify', title, body, session),
  onFocusTerminal: (callback: (session: string) => void): void => {
    ipcRenderer.on(
      'xtralab:focus-terminal',
      (_event: IpcRendererEvent, session: string) => callback(session)
    );
  }
});
