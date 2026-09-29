/** Cell inspector using the real classify pipeline.
 *  Usage: node scripts/debug-cell.mjs <fixtureSubstr> <row> <col> */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs, readPng } from './lib/util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = resolve(root, 'tests/fixtures');
const detect = await importTs(resolve(root, 'src/vision/detect.ts'));
const classify = await importTs(resolve(root, 'src/vision/classify.ts'));
const imageMod = await importTs(resolve(root, 'src/vision/image.ts'));

const [fileSub, rowS, colS] = process.argv.slice(2);
const fixtures = JSON.parse(readFileSync(resolve(fixtureDir, 'index.json'), 'utf8'));
const f = fixtures.find((x) => x.file.includes(fileSub));
const img = readPng(resolve(fixtureDir, f.file));
const hint = { x: f.boardRect.x - 3, y: f.boardRect.y + 2, w: f.boardRect.w + 4, h: f.boardRect.h - 1 };
const d = detect.detectBoard(img, [hint]);
const board = imageMod.crop(img, d.rect);
const a = classify.debugAnalyzeCell(board, Number(rowS), Number(colS));
console.log('occupied', a.occupied, 'medLum', a.medianLum.toFixed(0));
if (a.silhouette) {
  console.log('relH', a.silhouette.relHeight.toFixed(3), 'relW', a.silhouette.relWidth.toFixed(3), 'fill', a.silhouette.fill.toFixed(3));
  const g = a.silhouette.grid;
  for (let y = 0; y < 32; y++) {
    let line = '';
    for (let x = 0; x < 32; x++) {
      const v = g[y * 32 + x];
      line += v > 0.75 ? '#' : v > 0.4 ? '+' : v > 0.15 ? '.' : ' ';
    }
    console.log(line);
  }
  console.log('match', JSON.stringify(a.match));
  for (const t of a.perTemplate.slice(0, 8)) console.log(' ', t.id, t.score.toFixed(3));
}
