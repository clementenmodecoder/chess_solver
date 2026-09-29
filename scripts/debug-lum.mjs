import { importTs, readPng } from './lib/util.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const classify = await importTs(resolve(root, 'src/vision/classify.ts'));
const imageMod = await importTs(resolve(root, 'src/vision/image.ts'));
const sil = await importTs(resolve(root, 'src/vision/silhouette.ts'));

const file = process.argv[2] ?? 'tests/fixtures/cburnett-start-brown-256.png';
const img = readPng(resolve(root, file));
const size = img.width;
const board = imageMod.crop(img, { x: 0, y: 0, w: size, h: size });
const cs = size / 8;

for (const [r, c] of [[7, 0], [7, 1], [7, 2], [7, 3], [7, 4], [6, 0], [0, 0], [0, 3], [0, 1]]) {
  let x0 = Math.round(c * cs), y0 = Math.round(r * cs), x1 = Math.round((c + 1) * cs), y1 = Math.round((r + 1) * cs);
  const inset = Math.max(1, Math.round((x1 - x0) * 0.045));
  x0 += inset; y0 += inset; x1 -= inset; y1 -= inset;
  const w = x1 - x0, h = y1 - y0, d = board.data;
  const pp = Math.max(2, Math.round(Math.min(w, h) * 0.17));
  const corners = [[x0, y0], [x1 - pp, y0], [x0, y1 - pp], [x1 - pp, y1 - pp]];
  const means = corners.map(([cx, cy]) => {
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let y = cy; y < cy + pp; y++) {
      let i = (y * board.width + cx) * 4;
      for (let x = 0; x < pp; x++, i += 4) { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++; }
    }
    return [rr / n, gg / n, bb / n];
  });
  let best = Infinity, bg = means[0];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const dist = imageMod.colorDist(...means[i], ...means[j]);
    if (dist < best) { best = dist; bg = means[i].map((v, k) => (v + means[j][k]) / 2); }
  }
  const mask = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let i = ((y0 + y) * board.width + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const dist = imageMod.colorDist(d[i], d[i + 1], d[i + 2], bg[0], bg[1], bg[2]);
      const v = (dist - 25) / 40;
      mask[y * w + x] = v <= 0 ? 0 : v >= 1 ? 1 : v;
    }
  }
  const filled = sil.fillHoles(mask, w, h);
  const lums = [];
  for (let y = 0; y < h; y++) {
    let i = ((y0 + y) * board.width + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      if (filled[y * w + x] > 0.85) lums.push(imageMod.luminance(d[i], d[i + 1], d[i + 2]));
    }
  }
  lums.sort((a, b) => a - b);
  console.log(
    `r${r}c${c}`, 'bg', bg.map((v) => v.toFixed(0)).join(','),
    'medLum', lums.length ? lums[lums.length >> 1].toFixed(0) : '-', 'n', lums.length,
    'q25', lums.length ? lums[Math.floor(lums.length * 0.25)].toFixed(0) : '-',
    'q75', lums.length ? lums[Math.floor(lums.length * 0.75)].toFixed(0) : '-',
  );
}
