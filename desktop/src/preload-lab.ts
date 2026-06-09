import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Preload for the lab window (the JupyterLab page). It exposes only a
// notification bridge: the xtralab terminal-notifications plugin calls
// `window.xtralab.notify(...)` to forward an agent's notification to the OS,
// which the main process delivers (a native Notification on signed builds, or
// `osascript` on unsigned dev builds where Electron's own Notification is
// dropped). `onFocusTerminal` is the return path: the main process calls it when
// a native notification is clicked so the plugin can focus the terminal that
// fired it. The launcher window uses a separate, richer preload (`preload.ts`);
// the lab page gets nothing beyond this so the remote-served UI has the smallest
// possible surface.
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
