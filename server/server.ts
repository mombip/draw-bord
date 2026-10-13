import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
const MAX_BODY = 200 * 1024 * 1024; // pasted images live inside the board JSON

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface ServerOptions { port: number; host: string; staticDir: string; dataFile: string }

/** Serves the built app and GET/PUT /api/board. Resolves with the bound port. */
export function startServer({ port, host, staticDir, dataFile }: ServerOptions): Promise<number> {
  const root = resolve(staticDir);
  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? '/', 'http://x');
      if (pathname === '/api/board') {
        if (req.method === 'GET') {
          const body = await readFile(dataFile, 'utf8').catch(e => e.code === 'ENOENT' ? '{"objects":[]}' : Promise.reject(e));
          res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        } else if (req.method === 'PUT') {
          const body = await readBody(req);
          if (!Array.isArray(JSON.parse(body)?.objects)) return void res.writeHead(400).end('objects[] expected');
          await mkdir(dirname(dataFile), { recursive: true });
          const tmp = `${dataFile}.${randomUUID()}.tmp`;
          await writeFile(tmp, body);
          await rename(tmp, dataFile); // atomic: a crash never leaves a half-written board
          res.writeHead(204).end();
        } else res.writeHead(405).end();
        return;
      }
      const file = resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
      const data = await readFile(file).catch(() => null);
      if (!data) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(data);
    } catch (e: any) {
      if (!res.headersSent) res.writeHead(e?.status ?? (e instanceof SyntaxError ? 400 : 500)).end();
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok((server.address() as AddressInfo).port));
  });
}
