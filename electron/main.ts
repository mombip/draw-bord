import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { startServer } from '../server/server.js';

// Same backend as the browser build, on a random local port; board lives in the user's app data.
app.whenReady().then(async () => {
  const port = await startServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: join(app.getAppPath(), 'dist'),
    dataFile: join(app.getPath('userData'), 'board.json'),
  });
  const win = new BrowserWindow({ width: 1400, height: 900, autoHideMenuBar: true, title: 'Draw Board' });
  win.loadURL(`http://127.0.0.1:${port}`);
});
app.on('window-all-closed', () => app.quit());
