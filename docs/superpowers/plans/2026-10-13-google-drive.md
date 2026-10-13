# Google Drive Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web version auto-syncs the board to `draw_board_files/board.svg` on Google Drive and can save/open separate drawings there.

**Architecture:** New `src/drive.ts` owns sign-in (Google Identity Services token client) and Drive REST v3 calls via `fetch`, plus two pure helpers (`syncAction`, `multipart`). `src/main.ts` wires it into the existing persistence (`save()`, `saving` chain), file save/open and a new ☁ toolbar button + `<dialog>`. localStorage/backend stays the working copy; Drive is a mirror.

**Tech Stack:** TypeScript, Vite 8 (`import.meta.env`), Google Identity Services (`accounts.google.com/gsi/client`), Drive REST v3, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-13-google-drive-design.md`

## Global Constraints

- Scope `https://www.googleapis.com/auth/drive.file` only.
- Folder `draw_board_files` at the Drive root; synced board `board.svg` inside it.
- No backend, no client secret, no `gapi`, no new npm dependencies.
- Drive UI hidden in Electron (`window.desktop` present) and when `VITE_GOOGLE_CLIENT_ID` is empty.
- Uploads of the synced board at least 2 s apart, chained on the existing `saving` promise.
- Every board replacement from Drive goes through `edit()` (undoable).
- Tests run under `node --experimental-strip-types`: no TS parameter properties/enums in `src/*.ts`, and `drive.ts` must not touch `window`/`document` at module top level.

## Review Focus

1. Two tabs/devices connected at once: a pull must not trigger a push (else focus ping-pong uploads forever) — `pulling` flag in `save()`.
2. `board.svg` trashed or deleted in Drive while connected — next focus finds none and recreates it, never uploads into the trashed file.
3. Sign-in popup blocked or closed — status message, board keeps working and saving locally.
4. Token expires mid-session (401) — edits stay `unpushed`; the next click renews and pushes them.
5. Drive dialog open — Delete/Ctrl+Z/etc. must not act on the board behind it.

---

### Task 1: `drive.ts` pure helpers

**Files:**
- Create: `src/drive.ts`
- Test: `src/drive.test.ts`

**Interfaces:**
- Produces: `type DriveFile = { id: string; name: string; modifiedTime: string; version: string }`;
  `syncAction(remote: DriveFile | undefined, seenVersion: string, unpushed: boolean, localChanged: number): 'push' | 'pull' | 'none'`;
  `multipart(meta: object, text: string, boundary: string): string`; constants `FOLDER`, `SYNC`.

- [ ] **Step 1: Write the failing test** — `src/drive.test.ts`

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/drive.ts'`.

- [ ] **Step 3: Minimal implementation** — `src/drive.ts`

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass (existing `geom` tests + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/drive.ts src/drive.test.ts
git commit -m "Drive: sync decision and multipart upload helpers"
```

---

### Task 2: `drive.ts` sign-in and Drive REST calls

**Files:**
- Modify: `src/drive.ts` (append)

**Interfaces:**
- Consumes: `FOLDER`, `SYNC`, `DriveFile`, `multipart` from Task 1.
- Produces: `class DriveError extends Error { status: number }`; `clientId: string | undefined`;
  `connected(): boolean`; `needsRenewal(): boolean`; `load(): Promise<void>`; `signIn(): Promise<void>`;
  `signOut(): void`; `list(): Promise<DriveFile[]>`; `download(id: string): Promise<string>`;
  `create(name: string, text: string): Promise<DriveFile>`; `update(id: string, text: string): Promise<DriveFile>`;
  `getSync(): Promise<DriveFile | undefined>`; `putSync(text: string): Promise<DriveFile>`.

No unit tests: everything here is browser/network glue; it is exercised in Task 4's browser check.

- [ ] **Step 1: Append to `src/drive.ts`**

```ts
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
```

- [ ] **Step 2: Type-check and test**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all tests pass (the module still imports cleanly in Node: nothing touches `window`/`document` at top level, `import.meta.env` is `undefined` there).

- [ ] **Step 3: Commit**

```bash
git add src/drive.ts
git commit -m "Drive: token sign-in and Drive REST calls"
```

---

### Task 3: Wire Drive into the app

**Files:**
- Modify: `index.html` (CSP meta, styles, ☁ button, dialog)
- Modify: `src/main.ts` (import; `save()` ~L73; `saveFile()` ~L429; `openFile()` ~L479; keydown ~L491; new Drive section before `// ---------- keyboard + toolbar ----------`)
- Create: `.env`

**Interfaces:**
- Consumes: everything Task 2 produces; existing `edit`, `save`, `saving`, `status`, `flash`, `showFile`, `toSvg`, `svgToObjects`, `desktop`, `fileHandle`, `filePath`, `fileName`, `fileDirty`.

- [ ] **Step 1: `index.html`**

Replace the CSP meta with:

```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; connect-src 'self' ws: https://accounts.google.com/gsi/ https://www.googleapis.com">
```

Add before `</style>`:

```css
    [hidden] { display: none !important; }
    #drive-dlg { border: 0; border-radius: 10px; box-shadow: 0 4px 24px #0003; padding: 14px; min-width: 320px; font: inherit; }
    #drive-files { list-style: none; margin: 10px 0; padding: 0; max-height: 50vh; overflow: auto; }
    #drive-files button { width: 100%; display: flex; justify-content: space-between; gap: 16px; border: 0; background: none;
      padding: 6px 8px; border-radius: 6px; cursor: pointer; font: inherit; text-align: left; }
    #drive-files button:hover { background: #f0f0f0; }
    #drive-files small { color: #888; }
    .dlg-row { display: flex; gap: 6px; justify-content: flex-end; }
```

Add the button after the save button (`<button id="save" ...>`):

```html
    <button id="drive" title="Connect Google Drive" hidden>☁</button>
```

Add after `<div id="status"></div>`:

```html
  <dialog id="drive-dlg">
    <b>Google Drive · draw_board_files</b>
    <ul id="drive-files"></ul>
    <form method="dialog" class="dlg-row">
      <button type="button" id="drive-save">Save board as…</button>
      <button type="button" id="drive-off">Disconnect</button>
      <button>Close</button>
    </form>
  </dialog>
```

- [ ] **Step 2: `.env`** (a client ID is public; empty = Drive hidden)

```
# Google OAuth client ID (Web) for the Drive integration; see README "Google Drive". Empty: no Drive button.
VITE_GOOGLE_CLIENT_ID=
```

- [ ] **Step 3: `src/main.ts` — import** (after line 2)

```ts
import * as drive from './drive.ts';
```

- [ ] **Step 4: `src/main.ts` — `save()`**: insert after `if (!loaded) return;`

```ts
  if (!pulling) { // a change made here, not one pulled from Drive (pushing that back would ping-pong)
    unpushed = true;
    try { localStorage.setItem(CHANGED_KEY, String(Date.now())); } catch { /* storage off: first sync prefers Drive */ }
    if (drive.connected()) schedulePush();
  }
```

- [ ] **Step 5: `src/main.ts` — `saveFile()`**: Ctrl+S goes back to the Drive file when bound

Change the first line of the body and the start of the `try`:

```ts
  const text = toSvg(objects), toDrive = !!driveFile && !as;
  try {
    if (toDrive) driveFile = await drive.update(driveFile!.id, text);
    else if (desktop) {
```

and directly before `fileDirty = false; showFile();` in that function add:

```ts
    if (!toDrive) driveFile = null; // saved locally: Ctrl+S now goes to the local file
```

- [ ] **Step 6: `src/main.ts` — `openFile()`**: after `fileHandle = src.handle ?? null; ...` line add:

```ts
    driveFile = null;
```

- [ ] **Step 7: `src/main.ts` — keydown**: first line of the handler becomes

```ts
  if (e.target instanceof HTMLInputElement || driveDlg.open) return;
```

- [ ] **Step 8: `src/main.ts` — Drive section**, inserted before `// ---------- keyboard + toolbar ----------`

```ts
// ---------- Google Drive (web only; see drive.ts) ----------
// localStorage / the backend stays the working copy; Drive mirrors it in draw_board_files/board.svg.
const driveBtn = $<HTMLButtonElement>('drive'), driveDlg = $<HTMLDialogElement>('drive-dlg'), driveList = $('drive-files');
const CHANGED_KEY = 'drawboard-changed'; // when this browser last changed the board: decides the first sync
let driveFile: drive.DriveFile | null = null; // Ctrl+S target after Save/Open on Drive
let seenVersion = '', unpushed = false, pulling = false, pushTimer = 0, lastPush = 0;

const localChanged = () => { try { return Number(localStorage.getItem(CHANGED_KEY)) || 0; } catch { return 0; } };

function driveUi() {
  driveBtn.classList.toggle('on', drive.connected());
  driveBtn.title = drive.connected() ? 'Google Drive: synced · click for files' : 'Connect Google Drive';
}
function driveFailed(e: unknown) {
  status.textContent = (e as drive.DriveError).status === 401 ? 'Drive: click ☁ to reconnect' : `Drive: ${(e as Error).message}`;
  driveUi();
}

/** From save(): upload the board, at most every 2 s, in order with the other saves. */
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => saving = saving.then(push), Math.max(400, lastPush + 2000 - Date.now()));
}
async function push() {
  if (!drive.connected() || !unpushed) return;
  lastPush = Date.now(); unpushed = false;
  try { seenVersion = (await drive.putSync(toSvg(objects))).version; }
  catch (e) { unpushed = true; driveFailed(e); }
}
/** On connect and focus: bring the board in line with Drive (drive.syncAction decides). */
async function pull() {
  if (!drive.connected()) return;
  try {
    const remote = await drive.getSync();
    const act = drive.syncAction(remote, seenVersion, unpushed, localChanged());
    if (act === 'push') { unpushed = true; return push(); }
    if (act !== 'pull') return;
    const { objects: objs } = svgToObjects(await drive.download(remote!.id));
    seenVersion = remote!.version; unpushed = false;
    pulling = true;
    edit(() => { objects = objs; selected.clear(); }); // Ctrl+Z brings back what this replaced
    pulling = false;
  } catch (e) { driveFailed(e); }
}
function connectDrive() {
  drive.signIn().then(() => {
    if (status.textContent?.startsWith('Drive')) status.textContent = '';
    driveUi();
    saving = saving.then(pull);
  }, driveFailed);
}

async function showDrive() {
  const item = (text: string) => Object.assign(document.createElement('li'), { textContent: text });
  driveList.replaceChildren(item('Loading…'));
  driveDlg.showModal();
  try {
    const files = await drive.list();
    files.sort((a, b) => +(b.name === drive.SYNC) - +(a.name === drive.SYNC)); // synced board on top; stable, so the rest stay newest first
    driveList.replaceChildren(...files.map(f => {
      const b = document.createElement('button');
      b.textContent = f.name === drive.SYNC ? 'Synced board' : f.name.replace(/\.svg$/, '');
      b.append(Object.assign(document.createElement('small'), { textContent: new Date(f.modifiedTime).toLocaleString() }));
      b.onclick = () => { driveDlg.close(); openDrive(f); };
      const li = item(''); li.append(b); return li;
    }));
    if (!files.length) driveList.replaceChildren(item('No drawings yet: “Save board as…” adds one'));
  } catch (e) { driveDlg.close(); driveFailed(e); }
}
async function openDrive(f: drive.DriveFile) {
  try {
    const { objects: objs, skipped } = svgToObjects(await drive.download(f.id)); // throws before we touch the board
    edit(() => { objects = objs; selected.clear(); }); // undoable
    driveFile = f; fileHandle = null; filePath = undefined; fileName = f.name; fileDirty = false; showFile();
    status.textContent = skipped ? `Opened; skipped ${skipped} item(s) the board can't show` : '';
  } catch (e) { driveFailed(e); }
}
async function saveToDrive() {
  driveDlg.close();
  let name = prompt(`Save to Google Drive (${drive.FOLDER}) as:`, fileName?.replace(/\.svg$/, '') ?? 'drawing')?.trim();
  if (!name) return;
  if (!name.endsWith('.svg')) name += '.svg';
  if (name === drive.SYNC) { status.textContent = `${drive.SYNC} is the synced board; pick another name`; return; }
  try {
    driveFile = await drive.create(name, toSvg(objects));
    fileHandle = null; filePath = undefined; fileName = name; fileDirty = false; showFile();
    flash(`Saved ${name} to Drive`);
  } catch (e) { driveFailed(e); }
}

driveBtn.onclick = () => drive.connected() ? showDrive() : connectDrive();
$('drive-save').onclick = () => saveToDrive();
$('drive-off').onclick = () => {
  driveDlg.close(); drive.signOut();
  driveFile = null; seenVersion = ''; driveUi(); flash('Disconnected from Drive');
};
// renew on pointerup, not pointerdown: a popup mid-stroke could swallow the pointerup
canvas.addEventListener('pointerup', () => { if (drive.needsRenewal()) connectDrive(); });
addEventListener('focus', () => { if (drive.connected()) saving = saving.then(pull); });
if (drive.clientId && !desktop) drive.load().then(() => { driveBtn.hidden = false; driveUi(); }, () => {});
```

- [ ] **Step 9: Build and test**

Run: `npm run build && npm test`
Expected: `tsc` clean, Vite build succeeds, all tests pass.
Then: `grep -c VITE_GOOGLE_CLIENT_ID dist/assets/*.js` → `0` (Vite inlined the value; no raw `import.meta.env` left).

- [ ] **Step 10: Commit** (body records the strategy, as requested)

```bash
git add index.html src/main.ts .env
git commit -m "Google Drive sync and Save/Open for the web version

Lightweight, browser-only strategy: Google Identity Services gives the
page short-lived (~1 h) tokens and the page calls the Drive API itself.
No backend, no secret, drive.file permission only (the app sees just the
files it created, in draw_board_files/).

Trade-off: one click on the cloud button per tab, and a ~1 s popup when
the next click renews an expired token. A Netlify function holding a
refresh token can make that silent later."
```

---

### Task 4: Verify in the browser, document

**Files:**
- Modify: `README.md` (new "Google Drive" section after the feature paragraph, before `## Run`)

- [ ] **Step 1: Browser check with a fake Google** (no account needed; Playwright MCP)

Build with a dummy ID and serve: `VITE_GOOGLE_CLIENT_ID=test npx vite build && npx vite preview --port 4173`.
In Playwright, before load: route `https://accounts.google.com/gsi/client` to a stub that defines
`google.accounts.oauth2.initTokenClient(cfg)` returning `{ requestAccessToken: () => cfg.callback({ access_token: 't', expires_in: 3600 }) }`
and `revoke`; route `https://www.googleapis.com/**` to an in-memory fake (folder search → create folder,
files list/create/PATCH/`alt=media`, bumping `version` and `modifiedTime` on each write). Check:
1. ☁ visible; click → turns blue; first draw → after ~2 s a `board.svg` create, later draws → PATCH, not closer than 2 s apart.
2. Fake a remote change (bump version, new content), dispatch `focus` → board replaced; Ctrl+Z restores the previous board; no PATCH follows the pull (Review Focus 1).
3. Fake `board.svg` trashed → `focus` → a new `board.svg` is created (Review Focus 2).
4. ☁ → dialog lists "Synced board" first; while open, `Delete` does not delete the selection (Review Focus 5); *Save board as…* `board` → refused; `trip` → `trip.svg` created; Ctrl+S → PATCH to `trip.svg`.
5. Make the fake return 401 once → status `Drive: click ☁ to reconnect`; next click on the board → token re-requested, unsent board pushed (Review Focus 4).
6. Stub `requestAccessToken` to call `cfg.error_callback({ type: 'popup_closed' })` → status `Drive: sign-in cancelled`, drawing still saves locally (Review Focus 3).
7. Without `VITE_GOOGLE_CLIENT_ID` (`npx vite build`): ☁ hidden.

- [ ] **Step 2: README** — insert before `## Run`

```markdown
## Google Drive (web version)

Click ☁ in the toolbar to connect. The board then syncs to `draw_board_files/board.svg` in your
Drive: it is pulled again when you come back to the tab, the newer copy wins, and Ctrl+Z brings back
the one it replaced. Click ☁ again for your drawings in that folder: open one, or *Save board as…*
a new one; Ctrl+S then saves back to it. The app can only see files it created (`drive.file`).

Lightweight by design: there is no backend, the page gets short-lived tokens straight from Google.
So each new tab needs one click on ☁, and when the hourly token runs out your next click on the board
renews it (a popup flashes for a second; no password). Not in the desktop app yet.

Setup, once: in the [Google Cloud console](https://console.cloud.google.com/) create a project, enable
the **Google Drive API**, configure the **OAuth consent screen** (External; add yourself as a test
user), then **Credentials → Create OAuth client ID** of type *Web application* with authorized
JavaScript origins `https://draw-board-mp.netlify.app`, `http://localhost:5173`,
`http://localhost:3000` and `http://localhost:4173`. Put the client ID in `.env` as
`VITE_GOOGLE_CLIENT_ID` and rebuild.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: Google Drive section (lightweight browser-only sign-in, setup)"
```

- [ ] **Step 4: Real-account check (needs the user's client ID)** — put it in `.env`, `npm run build && npx vite preview --port 4173`, and walk the spec's manual list with the user: connect, draw → `board.svg` in Drive, second tab edit + refocus → pull, Save board as / Ctrl+S / open, Disconnect.
