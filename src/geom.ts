export type Pt = [number, number];
export interface Stroke { id: string; type: 'stroke'; points: Pt[]; color: string; width: number; straight?: boolean }
export interface Img { id: string; type: 'image'; x: number; y: number; w: number; h: number; src: string }
export type Obj = Stroke | Img;
export interface Box { x: number; y: number; w: number; h: number }

export function bbox(o: Obj): Box {
  if (o.type === 'image') return { x: o.x, y: o.y, w: o.w, h: o.h };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of o.points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const r = o.width / 2;
  return { x: x0 - r, y: y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
  const x1 = Math.max(...boxes.map(b => b.x + b.w)), y1 = Math.max(...boxes.map(b => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const inBox = (b: Box, [x, y]: Pt, pad = 0) =>
  x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;

const boxesTouch = (a: Box, b: Box) =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

function segDist([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Does a circle of radius r at p touch the object? */
export function hit(o: Obj, p: Pt, r: number): boolean {
  if (!inBox(bbox(o), p, r)) return false;
  if (o.type === 'image') return true;
  const pts = o.points, lim = o.width / 2 + r;
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <= lim;
  for (let i = 1; i < pts.length; i++) if (segDist(p, pts[i - 1], pts[i]) <= lim) return true;
  return false;
}

/** Does an eraser of radius r swept from a to b touch the object? */
export function hitSweep(o: Obj, a: Pt, b: Pt, r: number): boolean {
  const sweep = { x: Math.min(a[0], b[0]) - r, y: Math.min(a[1], b[1]) - r, w: Math.abs(b[0] - a[0]) + 2 * r, h: Math.abs(b[1] - a[1]) + 2 * r };
  if (!boxesTouch(bbox(o), sweep)) return false;
  // ponytail: sampled sweep, exact segment-segment distance if thin strokes get skipped
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (r / 2)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (hit(o, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], r)) return true;
  }
  return false;
}

/** Marquee test: image overlaps rect, or any stroke point lies in rect. */
export function hitsRect(o: Obj, b: Box): boolean {
  if (o.type === 'image') return boxesTouch(bbox(o), b);
  return o.points.some(p => inBox(b, p));
}

export function transform(o: Obj, f: (p: Pt) => Pt): Obj {
  if (o.type === 'stroke') return { ...o, points: o.points.map(f) };
  const [x0, y0] = f([o.x, o.y]), [x1, y1] = f([o.x + o.w, o.y + o.h]);
  return { ...o, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** One pass of [1,2,1] smoothing; endpoints kept. */
export function smooth(p: Pt[]): Pt[] {
  if (p.length < 3) return p;
  return p.map((q, i) => i === 0 || i === p.length - 1 ? q
    : [(p[i - 1][0] + 2 * q[0] + p[i + 1][0]) / 4, (p[i - 1][1] + 2 * q[1] + p[i + 1][1]) / 4]);
}

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/** Shape check for objects coming from clipboard or storage. */
export function isObj(o: any): o is Obj {
  if (!o || typeof o.id !== 'string') return false;
  if (o.type === 'stroke')
    return typeof o.color === 'string' && num(o.width) && Array.isArray(o.points) && o.points.length > 0
      && (o.straight === undefined || typeof o.straight === 'boolean')
      && o.points.every((p: any) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]));
  if (o.type === 'image')
    return [o.x, o.y, o.w, o.h].every(num) && typeof o.src === 'string' && o.src.startsWith('data:image/');
  return false;
}

export const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const r2 = (n: number) => Math.round(n * 100) / 100;
const XML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, c => XML[c]);

/** #rrggbbaa -> color + opacity attrs, for SVG viewers without CSS4 hex colors. */
function paint(color: string, attr: 'stroke' | 'fill') {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(color);
  return m ? `${attr}="#${m[1]}" ${attr}-opacity="${Math.round(parseInt(m[2], 16) / 0.255) / 1000}"` : `${attr}="${esc(color)}"`;
}

/** Path through the points, same as the canvas renderer: polyline if straight, else quadratic curves via midpoints. */
function strokeD(p: Pt[], straight?: boolean): string {
  let d = `M${p[0][0]} ${p[0][1]}`;
  if (straight) return d + p.slice(1).map(q => `L${q[0]} ${q[1]}`).join('');
  for (let i = 1; i < p.length - 1; i++)
    d += `Q${p[i][0]} ${p[i][1]} ${r2((p[i][0] + p[i + 1][0]) / 2)} ${r2((p[i][1] + p[i + 1][1]) / 2)}`;
  return d + `L${p[p.length - 1][0]} ${p[p.length - 1][1]}`;
}

/** Inverse of strokeD: exact points back (the Q control points are the samples), or null if it's someone else's path. */
export function parseOwnPath(d: string): { points: Pt[]; straight: boolean } | null {
  const n = '-?\\d+(?:\\.\\d+)?', pt = `${n} ${n}`;
  const v = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (new RegExp(`^M${pt}(L${pt}){2,}$`).test(d)) { // polyline (grid-snapped stroke)
    const pts: Pt[] = [];
    for (let i = 0; i < v.length; i += 2) pts.push([v[i], v[i + 1]]);
    return { points: pts, straight: true };
  }
  if (!new RegExp(`^M${pt}(Q${pt} ${pt})*L${pt}$`).test(d)) return null;
  const pts: Pt[] = [[v[0], v[1]]];
  for (let i = 2; i < v.length - 2; i += 4) pts.push([v[i], v[i + 1]]);
  pts.push([v[v.length - 2], v[v.length - 1]]);
  return { points: pts, straight: false };
}

/** Standalone SVG of the board. Reopening reads the drawing itself, so edits made in Inkscape etc. come back. */
export function toSvg(objs: Obj[]): string {
  const b = unionBox(objs.map(bbox)) ?? { x: 0, y: 0, w: 0, h: 0 }, pad = 20;
  const [x, y, w, h] = [b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad].map(r2);
  const body = objs.map(o => {
    if (o.type === 'image')
      return `<image xlink:href="${esc(o.src)}" x="${r2(o.x)}" y="${r2(o.y)}" width="${r2(o.w)}" height="${r2(o.h)}" preserveAspectRatio="none"/>`;
    const p = o.points.map(q => q.map(r2) as Pt);
    if (p.length === 1) return `<circle cx="${p[0][0]}" cy="${p[0][1]}" r="${r2(o.width / 2)}" ${paint(o.color, 'fill')}/>`;
    return `<path d="${strokeD(p, o.straight)}" fill="none" ${paint(o.color, 'stroke')} stroke-width="${r2(o.width)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">
<rect id="drawboard-bg" x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/>
${body.join('\n')}
</svg>
`;
}

/** Reads a .drawboard JSON file; drops anything that isn't a valid object. */
export function parseBoard(text: string): Obj[] {
  const d = JSON.parse(text);
  if (!Array.isArray(d?.objects)) throw new Error('not a Draw Board file');
  return d.objects.filter(isObj);
}
