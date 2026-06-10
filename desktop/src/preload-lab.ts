import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Preload for the lab window. It exposes only the notification bridge: the
// terminal-notifications plugin calls `notify` to forward an agent's
// notification to the main process, and `onFocusTerminal` is the return path the
// main process calls when a native notification is clicked. The launcher window
// uses a separate preload (`preload.ts`).
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
