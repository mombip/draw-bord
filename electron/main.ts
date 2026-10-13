import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';

// Native Save/Open dialogs. The web File System Access pickers need fresh user activation,
// which Electron doesn't regrant after a dialog closes, so the second Ctrl+S did nothing.
// The renderer may only write to paths the user picked in one of these dialogs.
const pickedPaths = new Set<string>();

ipcMain.handle('save-file', async (e, { text, suggestedName, path }: { text: string; suggestedName: string; path?: string }) => {
  if (!path || !pickedPaths.has(path)) {
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender)!, {
      defaultPath: suggestedName,
      filters: [{ name: 'SVG image (reopens in Draw Board)', extensions: ['svg'] }],
    });
    if (r.canceled || !r.filePath) return null;
    path = r.filePath;
    pickedPaths.add(path);
  }
  await writeFile(path, text);
  return { path, name: basename(path) };
});

ipcMain.handle('open-file', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, {
    properties: ['openFile'],
    filters: [{ name: 'Draw Board', extensions: ['svg', 'drawboard'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const path = r.filePaths[0];
  pickedPaths.add(path);
  return { path, name: basename(path), text: await readFile(path, 'utf8') };
});

// Same backend as the browser build, on a random local port; board lives in the user's app data.
app.whenReady().then(async () => {
  const port = await startServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: join(app.getAppPath(), 'dist'),
    dataFile: join(app.getPath('userData'), 'board.json'),
  });
  const win = new BrowserWindow({
    width: 1400, height: 900, autoHideMenuBar: true, title: 'Draw Board',
    webPreferences: { preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs') },
  });
  win.loadURL(`http://127.0.0.1:${port}`);
});
app.on('window-all-closed', () => app.quit());
