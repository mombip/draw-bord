import { parseOwnPath, uid, type Obj, type Pt } from './geom.ts';

// Not drawn directly, or not representable as board objects.
const SKIP_INSIDE = 'defs, clipPath, marker, pattern, mask, symbol, metadata';

/** Computed CSS color (rgb/rgba) * opacity -> #rrggbb[aa]; null for none/gradients. */
function hex(css: string, opacity: number): string | null {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(css);
  if (!m) return null;
  const a = opacity * (m[4] ? +m[4] : 1);
  const h = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return '#' + h(+m[1]) + h(+m[2]) + h(+m[3]) + (a < 0.999 ? h(a * 255) : '');
}

function hidden(el: Element, root: Element) {
  for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden') return true;
  }
  return false;
}

const isIdentity = (m: DOMMatrix) =>
  [m.a - 1, m.b, m.c, m.d - 1, m.e, m.f].every(v => Math.abs(v) < 1e-6);

/**
 * Reads what an SVG actually draws — ours, or one edited in Inkscape & co. — back into board objects.
 * Paths/shapes become strokes (exact points for our own untouched paths, sampled otherwise),
 * embedded images become images. Text, clones and linked images are counted as skipped.
 */
export function svgToObjects(text: string): { objects: Obj[]; skipped: number } {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('not a valid SVG file');
  doc.querySelectorAll('script, foreignObject').forEach(e => e.remove());

  // Must be in the live document so styles and transforms resolve; parked off-screen.
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
  host.append(svg);
  document.body.append(host);
  try {
    const toRoot = svg.getScreenCTM()!.inverse(); // root user space = board coordinates
    const objects: Obj[] = [];
    let skipped = 0;
    for (const el of svg.querySelectorAll<SVGElement>('*')) {
      if (el.closest(SKIP_INSIDE) || el.id === 'drawboard-bg' || hidden(el, svg)) continue;
      const tag = el.localName;
      if (tag === 'text' || tag === 'use') { skipped++; continue; }
      if (tag !== 'image' && !(el instanceof SVGGeometryElement)) continue;
      const m = toRoot.multiply((el as SVGGraphicsElement).getScreenCTM()!);
      const at = (x: number, y: number): Pt => { const q = new DOMPoint(x, y).matrixTransform(m); return [q.x, q.y]; };

      if (tag === 'image') {
        const img = el as SVGImageElement;
        const src = img.getAttribute('href') ?? img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
        if (!src.startsWith('data:image/')) { skipped++; continue; } // linked file, not embedded
        const [x, y, w, h] = [img.x, img.y, img.width, img.height].map(l => l.baseVal.value);
        const c = [at(x, y), at(x + w, y), at(x, y + h), at(x + w, y + h)];
        const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
        objects.push({ id: uid(), type: 'image', x: Math.min(...xs), y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), src });
        continue;
      }

      const geo = el as SVGGeometryElement, s = getComputedStyle(el), op = +s.opacity;
      const stroke = s.stroke === 'none' ? null : hex(s.stroke, +s.strokeOpacity * op);
      const fill = s.fill === 'none' ? null : hex(s.fill, +s.fillOpacity * op);
      if (!stroke && (!fill || fill.startsWith('#ffffff'))) continue; // invisible on a white board
      const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); // transform's scale, for widths

      if (!stroke && tag === 'circle') { // our dots: filled circle = one-point stroke
        const c = el as SVGCircleElement;
        objects.push({ id: uid(), type: 'stroke', points: [at(c.cx.baseVal.value, c.cy.baseVal.value)], color: fill!, width: 2 * c.r.baseVal.value * k });
        continue;
      }
      // ponytail: filled shapes come back as their outline only; real fills need a new object type
      const color = stroke ?? fill!, width = stroke ? parseFloat(s.strokeWidth) * k : 1;
      const own = tag === 'path' && isIdentity(m) ? parseOwnPath(el.getAttribute('d') ?? '') : null;
      if (own) { objects.push({ id: uid(), type: 'stroke', points: own, color, width }); continue; }

      // anything else: sample the outline; a jump means a new subpath -> new stroke
      const len = geo.getTotalLength(), step = Math.max(len / 5000, 2 / k);
      let pts: Pt[] = [], prev: DOMPoint | null = null;
      const flush = () => { if (pts.length) objects.push({ id: uid(), type: 'stroke', points: pts, color, width }); pts = []; };
      for (let d = 0; ; d = Math.min(len, d + step)) {
        const q = geo.getPointAtLength(d);
        if (prev && Math.hypot(q.x - prev.x, q.y - prev.y) > 3 * step) flush();
        pts.push(at(q.x, q.y));
        prev = q;
        if (d >= len) break;
      }
      flush();
    }
    return { objects, skipped };
  } finally {
    host.remove();
  }
}
