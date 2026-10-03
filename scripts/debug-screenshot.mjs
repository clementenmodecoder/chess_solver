/** Debug harness for a real screenshot: detect the board, classify it, and
 *  print per-cell color statistics + the resulting placement.
 *  Usage: node scripts/debug-screenshot.mjs <png> [x,y,w,h hint] */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs, readPng } from './lib/util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const detect = await importTs(resolve(root, 'src/vision/detect.ts'));
const classify = await importTs(resolve(root, 'src/vision/classify.ts'));
const imageMod = await importTs(resolve(root, 'src/vision/image.ts'));
const fenMod = await importTs(resolve(root, 'src/chess/fen.ts'));

const img = readPng(process.argv[2]);
const hint = process.argv[3] ? (() => { const [x, y, w, h] = process.argv[3].split(',').map(Number); return [{ x, y, w, h }]; })() : [];
const d = detect.detectBoard(img, hint);
console.log('detected', d ? JSON.stringify({ ...d.rect, score: +d.score.toFixed(3) }) : 'null');
if (!d) process.exit(1);
const board = imageMod.crop(img, d.rect);
const analyses = classify.analyzeBoard(board);
console.log('medianLum / whiteness per occupied cell:');
for (let r = 0; r < 8; r++) {
  console.log(analyses[r].map((a) => (a.occupied && a.features
    ? `${String(Math.round(a.medianLum)).padStart(3)}/${classify.whitenessScore(a.features).toFixed(1).padStart(5)}`
    : '    .    ')).join(' '));
}
const rec = classify.classifyBoard(board);
const o = fenMod.decideOrientation(rec.board);
console.log('placement', fenMod.placementFromMatrix(fenMod.orientMatrix(rec.board, o.whiteAtBottom)), 'conf', rec.confidence.toFixed(2));
