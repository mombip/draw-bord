import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startServer } from './server.js';

const root = fileURLToPath(new URL('../..', import.meta.url)); // dist-node/server -> repo root
const port = await startServer({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  staticDir: join(root, 'dist'),
  dataFile: process.env.BOARD_FILE ?? join(root, 'data', 'board.json'),
});
console.log(`Draw Board: http://localhost:${port}`);
