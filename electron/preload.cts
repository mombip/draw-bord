// CommonJS: sandboxed preloads can't be ES modules.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  saveFile: (text: string, suggestedName: string, path?: string) => ipcRenderer.invoke('save-file', { text, suggestedName, path }),
  openFile: () => ipcRenderer.invoke('open-file'),
});
