import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bbox, hit, hitSweep, hitsRect, isObj, parseBoard, parseOwnPath, smooth, toSvg, transform, unionBox, type Img, type Stroke } from './geom.ts';

const line: Stroke = { id: 's', type: 'stroke', points: [[0, 0], [100, 0]], color: '#000', width: 4 };
const img: Img = { id: 'i', type: 'image', x: 10, y: 10, w: 20, h: 10, src: 'data:image/png;base64,' };

test('bbox and union', () => {
  assert.deepEqual(bbox(line), { x: -2, y: -2, w: 104, h: 4 });
  assert.deepEqual(unionBox([bbox(line), bbox(img)]), { x: -2, y: -2, w: 104, h: 22 });
  assert.equal(unionBox([]), null);
});

test('hit', () => {
  assert.ok(hit(line, [50, 3], 2));
  assert.ok(!hit(line, [50, 10], 2));
  assert.ok(hit(img, [15, 15], 0));
  assert.ok(!hit(img, [5, 5], 0));
});

test('sweep catches a fast cross', () => {
  assert.ok(hitSweep(line, [50, -50], [50, 50], 2)); // neither end touches, path crosses
  assert.ok(!hitSweep(line, [200, -50], [200, 50], 2));
});

test('marquee', () => {
  assert.ok(hitsRect(line, { x: 90, y: -5, w: 20, h: 10 }));
  assert.ok(!hitsRect(line, { x: 0, y: 5, w: 20, h: 10 }));
  assert.ok(hitsRect(img, { x: 25, y: 15, w: 50, h: 50 }));
});

test('transform moves and scales; image stays normalized', () => {
  assert.deepEqual((transform(line, ([x, y]) => [x + 1, y + 2]) as Stroke).points, [[1, 2], [101, 2]]);
  assert.deepEqual(transform(img, ([x, y]) => [-x, y * 2]), { ...img, x: -30, y: 20, w: 20, h: 20 });
});

test('smooth keeps endpoints', () => {
  assert.deepEqual(smooth([[0, 0], [10, 10], [20, 0]]), [[0, 0], [10, 5], [20, 0]]);
});

test('isObj rejects junk', () => {
  assert.ok(isObj(line) && isObj(img));
  assert.ok(!isObj({ ...img, src: 'javascript:alert(1)' }));
  assert.ok(!isObj({ ...line, points: [[0, 'x']] }));
  assert.ok(!isObj(null));
});

test('parseBoard keeps valid objects, rejects non-boards', () => {
  assert.deepEqual(parseBoard(JSON.stringify({ objects: [line, { type: 'junk' }] })), [line]);
  assert.throws(() => parseBoard('{"foo":1}'));
  assert.throws(() => parseBoard('not json'));
});

test('svg output is safe and viewer-friendly', () => {
  const dot: Stroke = { id: 'd', type: 'stroke', points: [[5, 5]], color: '#ffd43b88', width: 10 };
  const evil: Stroke = { ...line, id: 'e', color: '"/><script>alert(1)</script>' };
  const svg = toSvg([line, img, dot, evil]);
  assert.ok(!svg.includes('<script'));
  assert.match(svg, /<circle [^>]*fill="#ffd43b" fill-opacity="0.533"/);
  assert.match(svg, /<path d="M0 0L100 0"/);
  assert.match(svg, /<image xlink:href="data:image\/png;base64," x="10"/);
  assert.match(svg, /viewBox="-22 -22 144 62"/);
  assert.doesNotThrow(() => toSvg([]));
});

test('own svg paths parse back to the exact points', () => {
  const pts: [number, number][] = [[0, 0], [10.5, -3.25], [20, 7], [31, 2]];
  const d = /<path d="([^"]+)"/.exec(toSvg([{ ...line, points: pts }]))![1];
  assert.deepEqual(parseOwnPath(d), pts);
  assert.deepEqual(parseOwnPath('M1 2L3 4'), [[1, 2], [3, 4]]);
  assert.equal(parseOwnPath('m 1,2 c 3,4 5,6 7,8'), null); // e.g. rewritten by Inkscape
});
