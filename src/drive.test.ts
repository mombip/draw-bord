import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multipart, syncAction, type DriveFile } from './drive.ts';

const remote: DriveFile = { id: 'f', name: 'board.svg', modifiedTime: '2026-10-13T10:00:00.000Z', version: '7' };
const older = Date.parse(remote.modifiedTime) - 1000, newer = Date.parse(remote.modifiedTime) + 1000;

test('no synced board yet: push ours', () => {
  assert.equal(syncAction(undefined, '', false, newer), 'push');
  assert.equal(syncAction(undefined, '7', false, newer), 'push'); // trashed since we last saw it
});

test('Drive unchanged since we last saw it: push only unsent edits', () => {
  assert.equal(syncAction(remote, '7', false, newer), 'none');
  assert.equal(syncAction(remote, '7', true, newer), 'push');
});

test('changed elsewhere and nothing unsent here: pull', () => {
  assert.equal(syncAction(remote, '6', false, newer), 'pull');
});

test('first connect, or unsent edits against a changed Drive copy: newer wins', () => {
  assert.equal(syncAction(remote, '', false, older), 'pull');
  assert.equal(syncAction(remote, '', false, newer), 'push');
  assert.equal(syncAction(remote, '', false, 0), 'pull'); // never drew in this browser
  assert.equal(syncAction(remote, '6', true, older), 'pull');
  assert.equal(syncAction(remote, '6', true, newer), 'push');
});

test('multipart upload body', () => {
  assert.equal(multipart({ name: 'a.svg' }, '<svg/>', 'B'),
    '--B\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.svg"}\r\n'
    + '--B\r\nContent-Type: image/svg+xml\r\n\r\n<svg/>\r\n--B--');
});

// ---------- Drive calls against a fake Google (sign-in + in-memory Drive behind fetch) ----------
import { getSync, needsRenewal, putSync, signIn } from './drive.ts';

type FakeFile = { id: string; name: string; parent?: string; folder?: boolean; trashed?: boolean; content?: string; version: number };
const store: FakeFile[] = [];
let nextId = 0, gis: (cfg: any) => void = cfg => cfg.callback({ access_token: 't', expires_in: 3600 });
(globalThis as any).window = { google: { accounts: { oauth2: {
  initTokenClient: (cfg: any) => ({ requestAccessToken: () => gis(cfg) }),
  revoke: () => {},
} } } };
const alive = (f: FakeFile) => !f.trashed && !(f.parent && store.find(p => p.id === f.parent)?.trashed);
globalThis.fetch = (async (url: string, init: any = {}) => {
  const u = new URL(url), m = init.method ?? 'GET';
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const meta = (f: FakeFile) => ({ id: f.id, name: f.name, modifiedTime: '2026-10-13T10:00:00.000Z', version: String(f.version) });
  if (m === 'GET' && u.pathname === '/drive/v3/files') {
    const q = u.searchParams.get('q')!, parent = q.match(/'([^']+)' in parents/)?.[1], name = q.match(/name = '([^']+)'/)?.[1];
    const hits = store.filter(f => alive(f) && (q.includes('google-apps.folder') ? f.folder : f.parent === parent) && (!name || f.name === name));
    return reply({ files: hits.map(meta) });
  }
  if (m === 'POST' && u.pathname === '/drive/v3/files') {
    const f = { id: `id${++nextId}`, folder: true, version: 1, ...JSON.parse(init.body) };
    store.push(f); return reply({ id: f.id });
  }
  if (m === 'POST') { // multipart create
    const md = JSON.parse(init.body.split('\r\n\r\n')[1].split('\r\n')[0]);
    if (!store.some(p => p.id === md.parents[0])) return reply({}, 404);
    const f = { id: `id${++nextId}`, name: md.name, parent: md.parents[0], version: 1, content: 'x' };
    store.push(f); return reply(meta(f));
  }
  const f = store.find(x => x.id === u.pathname.split('/').pop());
  if (!f) return reply({}, 404);
  f.version++; return reply(meta(f)); // PATCH
}) as typeof fetch;
const liveBoards = () => store.filter(f => f.name === 'board.svg' && alive(f));

test('a failed renewal stops asking on every click', async () => {
  gis = cfg => cfg.callback({ access_token: 't', expires_in: 60 }); // expiring soon
  await signIn();
  assert.ok(needsRenewal());
  gis = cfg => cfg.error_callback({ type: 'popup_closed' });
  await assert.rejects(signIn(), /sign-in cancelled/);
  assert.equal(needsRenewal(), false); // only an explicit click on the Drive button reconnects
});

test('a trashed draw_board_files folder: the synced board goes to a live folder', async () => {
  gis = cfg => cfg.callback({ access_token: 't', expires_in: 3600 });
  await signIn();
  await putSync('<svg/>');
  store.find(f => f.folder)!.trashed = true;
  assert.equal(await getSync(), undefined);
  await putSync('<svg/>');
  assert.equal(liveBoards().length, 1);
});

test('board.svg deleted for good while connected: the next push recreates it', async () => {
  await putSync('<svg/>');
  const [board] = liveBoards();
  store.splice(store.indexOf(board), 1);
  await putSync('<svg/>');
  assert.equal(liveBoards().length, 1);
});
