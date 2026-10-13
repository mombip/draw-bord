import { svgToObjects } from './svg-import.ts';
import * as drive from './drive.ts';
import { bbox, hit, hitSweep, hitsRect, inBox, isObj, parseBoard, smooth, toSvg, transform, uid, unionBox, type Box, type Obj, type Pt, type Stroke } from './geom.ts';

const PRESETS = [
  { color: '#1e1e1e', width: 2 },
  { color: '#1e1e1e', width: 6 },
  { color: '#1971c2', width: 3 },
  { color: '#e03131', width: 3 },
  { color: '#2f9e44', width: 3 },
  { color: '#ffd43b88', width: 22 }, // highlighter
];
const ERASE_R = 8; // screen px
const HANDLE = 6;  // screen px, half size

type Tool = 'pen' | 'select' | 'eraser';
type Drag =
  | { kind: 'draw'; stroke: Stroke }
  | { kind: 'erase'; last: Pt }
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { kind: 'move'; start: Pt; orig: Obj[] }
  | { kind: 'resize'; anchor: Pt; handle: Pt; orig: Obj[] }
  | { kind: 'marquee'; start: Pt; cur: Pt; base: Set<string> };

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const colorIn = $<HTMLInputElement>('color'), widthIn = $<HTMLInputElement>('width'), status = $('status');

let objects: Obj[] = [];
let selected = new Set<string>();
const eraseCand = new Set<string>();
const cam = { x: 0, y: 0, z: 1 };
let tool: Tool = 'pen';
const pen = { ...PRESETS[0] };
let mouse: Pt = [innerWidth / 2, innerHeight / 2]; // world coords, paste target
let spaceDown = false;
let snapHint: Pt | null = null; // Shift + pen: where the pen snaps to
let drag: Drag | null = null;
let before = ''; // board snapshot at gesture start

/** Spacing of the visible dot grid (coarser when zoomed out). */
function gridStep() { let step = 40; while (step * cam.z < 16) step *= 4; return step; }
const toGrid = ([x, y]: Pt): Pt => { const s = gridStep(); return [Math.round(x / s) * s, Math.round(y / s) * s]; };
const toWorld = (sx: number, sy: number): Pt => [sx / cam.z + cam.x, sy / cam.z + cam.y];
const selObjs = () => objects.filter(o => selected.has(o.id));
const selBox = () => unionBox(selObjs().map(bbox));
const corners = (b: Box): Pt[] => [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];

// ---------- history + persistence ----------
const undoStack: string[] = [], redoStack: string[] = [];
const snap = () => JSON.stringify(objects);
// ponytail: whole-board snapshots, per-op diffs if large pasted images make undo memory heavy
function commit(prev: string) {
  if (prev === snap()) return;
  undoStack.push(prev);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  save();
}
function edit(fn: () => void) { const prev = snap(); fn(); commit(prev); render(); }
function travel(from: string[], to: string[]) {
  const s = from.pop();
  if (s === undefined) return;
  to.push(snap());
  objects = JSON.parse(s);
  selected = new Set(objects.filter(o => selected.has(o.id)).map(o => o.id));
  save(); render();
}

// No backend (static hosting, e.g. Netlify) -> the board lives in this browser's localStorage.
const LOCAL_KEY = 'drawboard';
let loaded = false, local = false, saveTimer = 0, saving = Promise.resolve();
function save() { // every board change lands here
  fileDirty = true; showFile();
  if (!loaded) return;
  if (!pulling) { // a change made here, not one pulled from Drive (pushing that back would ping-pong)
    unpushed = true;
    try { localStorage.setItem(CHANGED_KEY, String(Date.now())); } catch { /* storage off: first sync prefers Drive */ }
    if (drive.connected()) schedulePush();
  }
  clearTimeout(saveTimer);
  // chained so PUTs reach the server in order: an older snapshot never overwrites a newer one
  saveTimer = window.setTimeout(() => saving = saving.then(async () => {
    const body = JSON.stringify({ objects });
    try {
      let ok = true;
      if (local) localStorage.setItem(LOCAL_KEY, body);
      else ok = (await fetch('/api/board', { method: 'PUT', headers: { 'content-type': 'application/json' }, body })).ok;
      if (!ok) status.textContent = 'Save failed (server error)';
      else if (status.textContent?.startsWith('Save failed')) status.textContent = ''; // leave other notices alone
    } catch { status.textContent = local ? 'Save failed (browser storage full)' : 'Save failed (server unreachable)'; }
  }), 400);
}
function load(d: any) {
  objects = [...(Array.isArray(d?.objects) ? d.objects.filter(isObj) : []), ...objects];
  loaded = true; render();
}
fetch('/api/board')
  .then(r => r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : Promise.reject())
  .then(load)
  .catch(() => {
    local = true;
    try { load(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? 'null')); }
    catch { status.textContent = 'Browser storage unavailable — board is not being saved'; }
  });

// ---------- rendering ----------
const images = new Map<string, HTMLImageElement>();
function image(src: string) {
  let img = images.get(src);
  if (!img) { img = new Image(); img.onload = render; img.src = src; images.set(src, img); }
  return img;
}

function drawObj(o: Obj, ghost: boolean) {
  ctx.globalAlpha = ghost ? 0.25 : 1;
  if (o.type === 'image') {
    const img = image(o.src);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, o.x, o.y, o.w, o.h);
  } else {
    const p = o.points;
    ctx.strokeStyle = ctx.fillStyle = ghost ? '#777' : o.color;
    ctx.lineWidth = o.width;
    ctx.beginPath();
    if (p.length === 1) { ctx.arc(p[0][0], p[0][1], o.width / 2, 0, Math.PI * 2); ctx.fill(); }
    else if (o.straight) { // grid-snapped: straight segments, sharp corners
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.stroke();
    } else {
      // quadratic curves through segment midpoints = smooth line through the samples
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++)
        ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

let frame = 0;
function render() { frame ||= requestAnimationFrame(draw); }
function draw() {
  frame = 0;
  const dpr = devicePixelRatio, z = cam.z;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * z * dpr, -cam.y * z * dpr);
  ctx.lineCap = ctx.lineJoin = 'round';

  // dot grid, so panning the infinite canvas is visible
  const step = gridStep();
  const [vx0, vy0] = toWorld(0, 0), [vx1, vy1] = toWorld(innerWidth, innerHeight), d = 1.5 / z;
  ctx.fillStyle = '#d4d4d4';
  ctx.beginPath();
  for (let x = Math.floor(vx0 / step) * step; x < vx1; x += step)
    for (let y = Math.floor(vy0 / step) * step; y < vy1; y += step) ctx.rect(x - d / 2, y - d / 2, d, d);
  ctx.fill();

  for (const o of objects) drawObj(o, eraseCand.has(o.id));
  if (drag?.kind === 'draw') drawObj(drag.stroke, false);

  ctx.lineWidth = 1 / z;
  ctx.strokeStyle = '#4263eb';
  const b = selBox();
  if (b) {
    ctx.setLineDash([4 / z, 4 / z]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    const h = HANDLE / z;
    for (const [x, y] of corners(b)) { ctx.fillRect(x - h, y - h, 2 * h, 2 * h); ctx.strokeRect(x - h, y - h, 2 * h, 2 * h); }
  }
  if (drag?.kind === 'marquee') {
    const [x0, y0] = drag.start, [x1, y1] = drag.cur;
    ctx.fillStyle = '#4263eb14';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
  if (snapHint) {
    ctx.strokeStyle = '#4263eb';
    ctx.beginPath();
    ctx.arc(snapHint[0], snapHint[1], 4 / z, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (tool === 'eraser' || drag?.kind === 'erase') {
    ctx.strokeStyle = '#888';
    ctx.beginPath();
    ctx.arc(mouse[0], mouse[1], ERASE_R / z, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  render();
}
addEventListener('resize', resize);
resize();

// ---------- pointer input ----------
function marqueeRect(d: Extract<Drag, { kind: 'marquee' }>): Box {
  return { x: Math.min(d.start[0], d.cur[0]), y: Math.min(d.start[1], d.cur[1]), w: Math.abs(d.cur[0] - d.start[0]), h: Math.abs(d.cur[1] - d.start[1]) };
}

/** Where on the selection is p: corner handle index, 'body', or null. */
function selPart(p: Pt): number | 'body' | null {
  const b = selBox();
  if (!b) return null;
  const h = (HANDLE + 2) / cam.z;
  const i = corners(b).findIndex(c => Math.abs(c[0] - p[0]) <= h && Math.abs(c[1] - p[1]) <= h);
  return i >= 0 ? i : inBox(b, p) ? 'body' : null;
}

function replaceSelected(orig: Obj[], f: (p: Pt) => Pt) {
  const byId = new Map(orig.map(o => [o.id, o]));
  objects = objects.map(o => byId.has(o.id) ? transform(byId.get(o.id)!, f) : o);
}

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('pointerdown', e => {
  if (drag) return;
  canvas.setPointerCapture(e.pointerId);
  const p = mouse = toWorld(e.clientX, e.clientY);
  before = snap();
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
  } else if (e.button === 2 || e.button === 5 || (e.button === 0 && tool === 'eraser')) { // 5 = stylus eraser end
    drag = { kind: 'erase', last: p };
    erase(p, p);
  } else if (e.button === 0) {
    const part = selPart(p);
    if (typeof part === 'number') {
      const c = corners(selBox()!);
      drag = { kind: 'resize', anchor: c[(part + 2) % 4], handle: c[part], orig: selObjs() };
    } else if (part === 'body') {
      drag = { kind: 'move', start: p, orig: selObjs() };
    } else if (tool === 'pen') {
      selected.clear();
      drag = { kind: 'draw', stroke: { id: uid(), type: 'stroke', points: [e.shiftKey ? toGrid(p) : p], color: pen.color, width: pen.width } };
    } else {
      const target = objects.findLast(o => hit(o, p, 4 / cam.z));
      if (target && e.shiftKey) {
        selected.has(target.id) ? selected.delete(target.id) : selected.add(target.id);
      } else if (target) {
        selected = new Set([target.id]);
        drag = { kind: 'move', start: p, orig: selObjs() };
      } else {
        drag = { kind: 'marquee', start: p, cur: p, base: e.shiftKey ? new Set(selected) : new Set() };
        selected = new Set(drag.base);
      }
    }
  }
  render();
});

function erase(a: Pt, b: Pt) {
  const r = ERASE_R / cam.z;
  for (const o of objects) if (!eraseCand.has(o.id) && hitSweep(o, a, b, r)) eraseCand.add(o.id);
}

canvas.addEventListener('pointermove', e => {
  const p = mouse = toWorld(e.clientX, e.clientY);
  const d = drag;
  const hint = tool === 'pen' && e.shiftKey && (!d || d.kind === 'draw') ? toGrid(p) : null;
  if (hint || snapHint) { snapHint = hint; render(); }
  if (!d) {
    const part = selPart(p);
    canvas.style.cursor = part === 'body' ? 'move' : part === 0 || part === 2 ? 'nwse-resize'
      : part === 1 || part === 3 ? 'nesw-resize' : tool === 'pen' ? 'crosshair' : tool === 'eraser' ? 'none' : 'default';
    if (tool === 'eraser') render();
    return;
  }
  switch (d.kind) {
    case 'pan':
      cam.x = d.cx - (e.clientX - d.sx) / cam.z;
      cam.y = d.cy - (e.clientY - d.sy) / cam.z;
      break;
    case 'draw': {
      const pts = d.stroke.points;
      for (const ce of e.getCoalescedEvents?.() ?? [e]) {
        const last = pts[pts.length - 1];
        if (ce.shiftKey) { // snap to the grid: straight segments between grid points
          const w = toWorld(ce.clientX, ce.clientY), q = toGrid(w);
          // only take a grid point once the pointer is near it, so a shaky hand between rows doesn't zigzag
          const near = Math.hypot(w[0] - q[0], w[1] - q[1]) < gridStep() * 0.35;
          if (near && (q[0] !== last[0] || q[1] !== last[1])) { pts.push(q); d.stroke.straight = true; }
        } else {
          const q = toWorld(ce.clientX, ce.clientY);
          if (Math.hypot(q[0] - last[0], q[1] - last[1]) * cam.z >= 1.5) pts.push(q);
        }
      }
      break;
    }
    case 'erase':
      erase(d.last, p);
      d.last = p;
      break;
    case 'move':
      replaceSelected(d.orig, ([x, y]) => [x + p[0] - d.start[0], y + p[1] - d.start[1]]);
      break;
    case 'resize': {
      const [ax, ay] = d.anchor, hx = d.handle[0] - ax, hy = d.handle[1] - ay;
      let sx = (p[0] - ax) / hx, sy = (p[1] - ay) / hy;
      // uniform by default (projection on the diagonal), Shift = free
      if (!e.shiftKey) sx = sy = ((p[0] - ax) * hx + (p[1] - ay) * hy) / (hx * hx + hy * hy);
      sx = Math.max(sx, 0.01); sy = Math.max(sy, 0.01);
      replaceSelected(d.orig, ([x, y]) => [ax + (x - ax) * sx, ay + (y - ay) * sy]);
      break;
    }
    case 'marquee': {
      d.cur = p;
      const r = marqueeRect(d);
      selected = new Set([...d.base, ...objects.filter(o => hitsRect(o, r)).map(o => o.id)]);
      break;
    }
  }
  render();
});

function endDrag() {
  const d = drag;
  if (!d) return;
  drag = null;
  if (d.kind === 'draw') {
    const { straight, ...s } = d.stroke;
    objects.push(straight && s.points.length > 2 ? { ...s, straight } : { ...s, points: straight ? s.points : smooth(s.points) });
  }
  if (d.kind === 'erase' && eraseCand.size) {
    objects = objects.filter(o => !eraseCand.has(o.id));
    for (const id of eraseCand) selected.delete(id);
  }
  eraseCand.clear();
  commit(before);
  render();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.shiftKey) { // Shift+wheel pans (browsers turn it into deltaX)
    cam.x += e.deltaX / cam.z;
    cam.y += e.deltaY / cam.z;
  } else { // wheel zooms around the cursor; Ctrl+wheel = trackpad pinch, small deltas
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : 1); // Firefox reports lines
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    cam.z = Math.min(8, Math.max(0.1, cam.z * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002))));
    cam.x = wx - e.clientX / cam.z;
    cam.y = wy - e.clientY / cam.z;
  }
  mouse = toWorld(e.clientX, e.clientY);
  render();
}, { passive: false });

// ---------- clipboard ----------
function placeAtMouse(objs: Obj[]) {
  const b = unionBox(objs.map(bbox))!;
  const dx = mouse[0] - (b.x + b.w / 2), dy = mouse[1] - (b.y + b.h / 2);
  const placed = objs.map(o => ({ ...transform(o, ([x, y]) => [x + dx, y + dy]), id: uid() }));
  edit(() => objects.push(...placed));
  selected = new Set(placed.map(o => o.id)); // pasted stuff is selected, drag to move it
  render();
}

async function pasteImage(file: File) {
  const src = await new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.onerror = fail;
    r.readAsDataURL(file);
  });
  const img = image(src);
  await img.decode();
  // natural pixel size on screen, shrunk to fit 80% of the window
  const k = Math.min(1, (0.8 * innerWidth) / img.naturalWidth, (0.8 * innerHeight) / img.naturalHeight) / cam.z;
  placeAtMouse([{ id: '', type: 'image', x: 0, y: 0, w: img.naturalWidth * k, h: img.naturalHeight * k, src }]);
}

function copySelection(e: ClipboardEvent) {
  const sel = selObjs();
  if (!sel.length || !e.clipboardData) return false;
  e.clipboardData.setData('text/plain', JSON.stringify({ drawboard: sel }));
  e.preventDefault();
  return true;
}
const deleteSelected = () => edit(() => { objects = objects.filter(o => !selected.has(o.id)); selected.clear(); });

document.addEventListener('copy', copySelection);
document.addEventListener('cut', e => { if (!driveDlg.open && copySelection(e)) deleteSelected(); });
document.addEventListener('paste', e => {
  if (driveDlg.open) return; // the board is behind the Drive dialog
  const dt = e.clipboardData;
  if (!dt) return;
  const file = [...dt.items].find(i => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
  if (file) {
    e.preventDefault();
    pasteImage(file).catch(() => { status.textContent = 'Could not read pasted image'; });
    return;
  }
  try {
    const objs = JSON.parse(dt.getData('text/plain'))?.drawboard;
    if (Array.isArray(objs) && objs.length && objs.every(isObj)) { e.preventDefault(); placeAtMouse(objs); }
  } catch { /* not ours */ }
});

// ---------- local files ----------
// Electron: native dialogs through the preload bridge (window.desktop).
// Chromium: File System Access API — real dialogs, Ctrl+S back to the same file.
// Elsewhere: download a copy / <input type=file>.
type Desktop = {
  saveFile(text: string, suggestedName: string, path?: string): Promise<{ path: string; name: string } | null>;
  openFile(): Promise<{ path: string; name: string; text: string } | null>;
};
const desktop = (window as any).desktop as Desktop | undefined;
const fsApi = window as any; // pickers aren't in TS's DOM lib yet
const SAVE_TYPES = [{ description: 'SVG image (reopens in Draw Board)', accept: { 'image/svg+xml': ['.svg'] } }];
const OPEN_TYPES = [{ description: 'Draw Board', accept: { 'image/svg+xml': ['.svg'], 'application/json': ['.drawboard'] } }];
let fileHandle: any = null, filePath: string | undefined, fileName: string | null = null, fileDirty = false;

function showFile() {
  document.title = fileName ? `${fileDirty ? '• ' : ''}${fileName} — Draw Board` : 'Draw Board';
}

/** Short green notice in the status corner. */
function flash(msg: string) {
  status.textContent = msg;
  status.style.color = '#2b8a3e';
  setTimeout(() => { if (status.textContent === msg) status.textContent = ''; status.style.color = ''; }, 2000);
}

async function saveFile(as: boolean) {
  const text = toSvg(objects), toDrive = !!driveFile && !as;
  try {
    if (toDrive) driveFile = await drive.update(driveFile!.id, text);
    else if (desktop) {
      const r = await desktop.saveFile(text, fileName ?? 'board.svg', as ? undefined : filePath);
      if (!r) return; // cancelled
      filePath = r.path; fileName = r.name;
    } else if (fsApi.showSaveFilePicker) {
      if (as || !fileHandle) fileHandle = await fsApi.showSaveFilePicker({ suggestedName: fileName ?? 'board.svg', types: SAVE_TYPES });
      const out = await fileHandle.createWritable();
      await out.write(text);
      await out.close();
      fileName = fileHandle.name;
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
      a.download = fileName ??= 'board.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
    if (!toDrive) driveFile = null; // saved locally: Ctrl+S now goes to the local file
    fileDirty = false; showFile();
    flash(`Saved ${fileName}`);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') status.textContent = `Could not save file: ${(e as Error).message}`;
  }
}

const pickFile = () => new Promise<File>((ok, fail) => {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.svg,.drawboard' });
  input.onchange = () => input.files?.[0] ? ok(input.files[0]) : fail(new DOMException('', 'AbortError'));
  input.oncancel = () => fail(new DOMException('', 'AbortError'));
  input.click();
});

async function openFile() {
  try {
    let src: { text: string; name: string; handle?: any; path?: string } | null;
    if (desktop) src = await desktop.openFile();
    else if (fsApi.showOpenFilePicker) {
      const [handle] = await fsApi.showOpenFilePicker({ types: OPEN_TYPES });
      const file: File = await handle.getFile();
      src = { text: await file.text(), name: file.name, handle };
    } else {
      const file = await pickFile();
      src = { text: await file.text(), name: file.name };
    }
    if (!src) return; // cancelled
    // parse throws before we adopt the file: Ctrl+S never overwrites a bad pick
    const { objects: objs, skipped } = src.text.trimStart().startsWith('<') ? svgToObjects(src.text) : { objects: parseBoard(src.text), skipped: 0 };
    edit(() => { objects = objs; selected.clear(); }); // undoable
    fileHandle = src.handle ?? null; filePath = src.path; fileName = src.name; fileDirty = false; showFile();
    driveFile = null;
    status.textContent = skipped ? `Opened; skipped ${skipped} item(s) the board can't show (text, clones, linked images)` : '';
  } catch (e) {
    if ((e as Error).name !== 'AbortError') status.textContent = `Could not open file: ${(e as Error).message}`;
  }
}

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
  status.textContent = (e as drive.DriveError).status === 401 ? 'Drive: click the Drive button to reconnect' : `Drive: ${(e as Error).message}`;
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

// ---------- keyboard + toolbar ----------
function setTool(t: Tool) { tool = t; ui(); render(); }
function setPen(p: { color: string; width: number }) { Object.assign(pen, p); setTool('pen'); }

addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || driveDlg.open) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (k === 'shift' && tool === 'pen' && !drag) snapHint = toGrid(mouse);
  if (k === ' ') { spaceDown = true; e.preventDefault(); }
  else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? travel(redoStack, undoStack) : travel(undoStack, redoStack); }
  else if (mod && k === 'y') { e.preventDefault(); travel(redoStack, undoStack); }
  else if (mod && k === 's') { e.preventDefault(); saveFile(e.shiftKey); }
  else if (mod && k === 'o') { e.preventDefault(); openFile(); }
  else if (mod && k === 'a') { e.preventDefault(); selected = new Set(objects.map(o => o.id)); }
  else if (k === 'delete' || k === 'backspace') deleteSelected();
  else if (k === 'escape') {
    selected.clear(); eraseCand.clear();
    if (drag?.kind === 'erase') drag = null;
  }
  else if (!mod && k === 'v') setTool('select');
  else if (!mod && k === 'p') setTool('pen');
  else if (!mod && k === 'e') setTool('eraser');
  else if (!mod && PRESETS[+k - 1]) setPen(PRESETS[+k - 1]);
  render();
});
addEventListener('keyup', e => {
  if (e.key === ' ') spaceDown = false;
  if (e.key === 'Shift' && snapHint) { snapHint = null; render(); }
});

const presetBox = $('presets');
PRESETS.forEach((p, i) => {
  const btn = document.createElement('button');
  btn.title = `Preset ${i + 1}`;
  const s = Math.min(20, Math.max(4, p.width * 1.5)) + 'px';
  btn.innerHTML = `<span class="dot" style="width:${s};height:${s};background:${p.color}"></span>`;
  btn.onclick = () => setPen(p);
  presetBox.append(btn);
});
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool as Tool));
$('open').onclick = () => openFile();
$('save').onclick = e => saveFile(e.shiftKey);
$('undo').onclick = () => travel(undoStack, redoStack);
$('redo').onclick = () => travel(redoStack, undoStack);
colorIn.oninput = () => setPen({ color: colorIn.value, width: pen.width });
widthIn.oninput = () => setPen({ color: pen.color, width: +widthIn.value });
// keep focus on the board so Space/Delete don't hit toolbar buttons
$('toolbar').addEventListener('mousedown', e => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); });

function ui() {
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
  [...presetBox.children].forEach((b, i) =>
    b.classList.toggle('on', tool === 'pen' && PRESETS[i].color === pen.color && PRESETS[i].width === pen.width));
  colorIn.value = pen.color.slice(0, 7);
  widthIn.value = String(pen.width);
}
ui();
