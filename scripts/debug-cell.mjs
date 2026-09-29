/** Inspect one cell's extracted silhouette vs templates. Usage:
 *  node scripts/debug-cell.mjs <fixture> <row> <col> */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs, readPng } from './lib/util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = resolve(root, 'tests/fixtures');

const detect = await importTs(resolve(root, 'src/vision/detect.ts'));
const imageMod = await importTs(resolve(root, 'src/vision/image.ts'));
const sil = await importTs(resolve(root, 'src/vision/silhouette.ts'));
const tmpl = await importTs(resolve(root, 'src/vision/templates.ts'));

const [file, rowS, colS] = process.argv.slice(2);
const r = Number(rowS), c = Number(colS);
const fixtures = JSON.parse(readFileSync(resolve(fixtureDir, 'index.json'), 'utf8'));
const f = fixtures.find((x) => x.file.includes(file));
const img = readPng(resolve(fixtureDir, f.file));
const hint = { x: f.boardRect.x - 3, y: f.boardRect.y + 2, w: f.boardRect.w + 4, h: f.boardRect.h - 1 };
const d = detect.detectBoard(img, [hint]);
console.log('rect', JSON.stringify(d.rect));
const board = imageMod.crop(img, d.rect);

const cw = board.width / 8, ch = board.height / 8;
const x0 = Math.round(c * cw), y0 = Math.round(r * ch);
const x1 = Math.round((c + 1) * cw), y1 = Math.round((r + 1) * ch);
const w = x1 - x0, h = y1 - y0;

// Replicate analyzeCell's bg estimation + mask.
const p = Math.max(2, Math.round(Math.min(w, h) * 0.17));
const corners = [[x0, y0], [x1 - p, y0], [x0, y1 - p], [x1 - p, y1 - p]];
const d8 = board.data;
const means = corners.map(([cx, cy]) => {
  let rr = 0, gg = 0, bb = 0, n = 0;
  for (let y = cy; y < cy + p; y++) {
    let i = (y * board.width + cx) * 4;
    for (let x = 0; x < p; x++, i += 4) { rr += d8[i]; gg += d8[i + 1]; bb += d8[i + 2]; n++; }
  }
  return [rr / n, gg / n, bb / n];
});
console.log('corner means', means.map((m) => m.map((v) => v.toFixed(0)).join(',')));
let best = Infinity, bg = means[0];
for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
  const dist = imageMod.colorDist(...means[i], ...means[j]);
  if (dist < best) { best = dist; bg = means[i].map((v, k) => (v + means[j][k]) / 2); }
}
console.log('bg', bg.map((v) => v.toFixed(0)).join(','));

const mask = new Float32Array(w * h);
for (let y = 0; y < h; y++) {
  let i = ((y0 + y) * board.width + x0) * 4;
  for (let x = 0; x < w; x++, i += 4) {
    const dist = imageMod.colorDist(d8[i], d8[i + 1], d8[i + 2], bg[0], bg[1], bg[2]);
    const v = (dist - 25) / 40;
    mask[y * w + x] = v <= 0 ? 0 : v >= 1 ? 1 : v;
  }
}
const filled = sil.fillHoles(mask, w, h);

function printGrid(g, gw, gh, step = 1) {
  for (let y = 0; y < gh; y += step) {
    let line = '';
    for (let x = 0; x < gw; x += step) {
      const v = g[y * gw + x];
      line += v > 0.75 ? '#' : v > 0.4 ? '+' : v > 0.15 ? '.' : ' ';
    }
    console.log(line);
  }
}
console.log('--- raw mask ---');
printGrid(mask, w, h, Math.max(1, Math.round(w / 32)));
console.log('--- filled mask ---');
printGrid(filled, w, h, Math.max(1, Math.round(w / 32)));

const s = sil.normalizeSilhouette(filled, w, h);
console.log('relH', s.relHeight.toFixed(3), 'relW', s.relWidth.toFixed(3), 'fill', s.fill.toFixed(3));
console.log('--- normalized ---');
printGrid(s.grid, 32, 32);

const templates = tmpl.loadTemplates();
const scores = [];
for (const t of templates) {
  const score = sil.silhouetteSimilarity(s.grid, t.grid) - 0.5 * Math.abs(s.relHeight - t.relHeight);
  scores.push({ id: `${t.set}/${t.color}${t.piece}`, score, relH: t.relHeight });
}
scores.sort((a, b) => b.score - a.score);
for (const sc of scores.slice(0, 10)) console.log(sc.id, sc.score.toFixed(3), 'relH', sc.relH);
