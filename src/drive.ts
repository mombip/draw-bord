/// <reference types="vite/client" />
// Google Drive for the web version, the lightweight way: Google Identity Services hands the page
// short-lived (~1 h) access tokens and we call Drive REST v3 with fetch. No backend, no secret.
// The price: one click on ☁ per tab, and a ~1 s popup flash when a click renews the token.
// ponytail: popup renewals; a Netlify function holding a refresh token makes them silent if that grates.
// Scope drive.file: the app only ever sees files it created itself.

export const FOLDER = 'draw_board_files', SYNC = 'board.svg';
export type DriveFile = { id: string; name: string; modifiedTime: string; version: string };

/** What to do with the synced board on connect/focus. Last write wins; the caller makes a pull undoable. */
export function syncAction(remote: DriveFile | undefined, seenVersion: string, unpushed: boolean, localChanged: number): 'push' | 'pull' | 'none' {
  if (!remote) return 'push';
  if (remote.version === seenVersion) return unpushed ? 'push' : 'none';
  // ponytail: compares two devices' clocks; fine for one person, server-side versions if it isn't
  if (!seenVersion || unpushed) return Date.parse(remote.modifiedTime) > localChanged ? 'pull' : 'push';
  return 'pull';
}

/** multipart/related body: file metadata + SVG content in one upload. */
export function multipart(meta: object, text: string, boundary: string) {
  return `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
    + `--${boundary}\r\nContent-Type: image/svg+xml\r\n\r\n${text}\r\n--${boundary}--`;
}

export class DriveError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export const clientId: string | undefined = import.meta.env?.VITE_GOOGLE_CLIENT_ID || undefined;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files', UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,name,modifiedTime,version';

// ---------- sign-in ----------
let token = '', expires = 0, wanted = false, client: any = null, inflight: Promise<void> | null = null;
let pending: { ok(): void; fail(e: Error): void } | null = null;

export const connected = () => !!token && Date.now() < expires;
/** Connected in this tab, but the token is gone or about to expire: renew on the next click. */
export const needsRenewal = () => wanted && Date.now() > expires - 5 * 60_000;

/** Loads Google's sign-in script; call early so a click can open the popup right away. */
export function load(): Promise<void> {
  return new Promise((ok, fail) => document.head.append(Object.assign(document.createElement('script'), {
    src: 'https://accounts.google.com/gsi/client', onload: () => ok(), onerror: () => fail(new Error('Google sign-in could not load')),
  })));
}

/** Call from a click: browsers only allow Google's popup right after user input. */
export function signIn(): Promise<void> {
  return inflight ??= new Promise<void>((ok, fail) => {
    const oauth = (window as any).google?.accounts?.oauth2;
    if (!oauth) return fail(new Error('Google sign-in not loaded'));
    client ??= oauth.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: (r: any) => {
        if (r.error) return pending?.fail(new Error(r.error_description ?? r.error));
        token = r.access_token; expires = Date.now() + Number(r.expires_in) * 1000; wanted = true;
        pending?.ok();
      },
      error_callback: (e: any) => pending?.fail(new Error(e.type === 'popup_closed' ? 'sign-in cancelled' : e.message ?? e.type)),
    });
    pending = { ok, fail };
    client.requestAccessToken({ prompt: '' }); // asks for consent only the first time
  }).finally(() => inflight = null);
}

export function signOut() {
  (window as any).google?.accounts?.oauth2?.revoke(token, () => {});
  token = ''; expires = 0; wanted = false; folderP = null; syncId = '';
}

// ---------- Drive REST v3 ----------
async function call(url: string, init: { method?: string; body?: string; type?: string } = {}): Promise<Response> {
  if (!connected()) throw new DriveError('session expired', 401);
  const r = await fetch(url, {
    method: init.method, body: init.body,
    headers: { Authorization: `Bearer ${token}`, ...(init.type ? { 'Content-Type': init.type } : {}) },
  });
  if (r.status === 401) { token = ''; expires = 0; throw new DriveError('session expired', 401); }
  if (!r.ok) throw new DriveError(`error ${r.status}`, r.status);
  return r;
}

const q = encodeURIComponent;
async function find(query: string): Promise<DriveFile[]> {
  const r = await call(`${API}?q=${q(`${query} and trashed = false`)}&orderBy=${q('modifiedTime desc')}&fields=${q(`files(${FIELDS})`)}&pageSize=1000`);
  return (await r.json()).files;
}

let folderP: Promise<string> | null = null, syncId = '';
/** Id of draw_board_files, created on first use. */
function folder(): Promise<string> {
  return folderP ??= (async () => {
    const [f] = await find(`name = '${FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents`);
    if (f) return f.id;
    const r = await call(`${API}?fields=id`, { method: 'POST', type: 'application/json', body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) });
    return (await r.json()).id as string;
  })().catch(e => { folderP = null; throw e; });
}

/** Draw Board's .svg files in the folder, newest first. */
export async function list(): Promise<DriveFile[]> {
  return find(`'${await folder()}' in parents and mimeType = 'image/svg+xml'`);
}

export async function download(id: string): Promise<string> {
  return (await call(`${API}/${id}?alt=media`)).text();
}

export async function create(name: string, text: string): Promise<DriveFile> {
  const boundary = `drawboard-${crypto.randomUUID()}`;
  const meta = { name, parents: [await folder()], mimeType: 'image/svg+xml' };
  return (await call(`${UPLOAD}?uploadType=multipart&fields=${FIELDS}`, {
    method: 'POST', type: `multipart/related; boundary=${boundary}`, body: multipart(meta, text, boundary),
  })).json();
}

export async function update(id: string, text: string): Promise<DriveFile> {
  return (await call(`${UPLOAD}/${id}?uploadType=media&fields=${FIELDS}`, { method: 'PATCH', type: 'image/svg+xml', body: text })).json();
}

/** The synced board's metadata; undefined when there is none (never made, or trashed). */
export async function getSync(): Promise<DriveFile | undefined> {
  const [f] = await find(`'${await folder()}' in parents and name = '${SYNC}'`);
  syncId = f?.id ?? ''; // forget a trashed one so putSync recreates it
  return f;
}

export async function putSync(text: string): Promise<DriveFile> {
  const f = syncId ? await update(syncId, text) : await create(SYNC, text);
  syncId = f.id;
  return f;
}
