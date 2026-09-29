/** Debug harness: run the vision pipeline on fixtures and print details. */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs, readPng } from './lib/util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = resolve(root, 'tests/fixtures');

const detect = await importTs(resolve(root, 'src/vision/detect.ts'));
const classify = await importTs(resolve(root, 'src/vision/classify.ts'));
const imageMod = await importTs(resolve(root, 'src/vision/image.ts'));
const fen = await importTs(resolve(root, 'src/chess/fen.ts'));

const fixtures = JSON.parse(readFileSync(resolve(fixtureDir, 'index.json'), 'utf8'));
const filter = process.argv[2] || '';
const mode = process.argv[3] || 'full'; // full | detect | cells

for (const f of fixtures) {
  if (filter && !f.file.includes(filter)) continue;
  const img = readPng(resolve(fixtureDir, f.file));

  if (mode === 'scan') {
    const t0 = Date.now();
    const d = detect.scanForBoard(img);
    console.log(f.file, 'scan:', d ? JSON.stringify({ ...d.rect, score: +d.score.toFixed(3) }) : 'null',
      `want ${JSON.stringify(f.boardRect)}`, `${Date.now() - t0}ms`);
    continue;
  }

  const hint = { x: f.boardRect.x - 3, y: f.boardRect.y + 2, w: f.boardRect.w + 4, h: f.boardRect.h - 1 };
  const d = detect.detectBoard(img, [hint]);
  if (!d) {
    const raw = detect.checkerScore(img, f.boardRect);
    console.log(f.file, 'DETECT FAIL', 'true-rect score:', JSON.stringify(raw));
    continue;
  }
  const rec = classify.classifyBoard(imageMod.crop(img, d.rect));
  const orientation = fen.decideOrientation(rec.board);
  const oriented = fen.orientMatrix(rec.board, orientation.whiteAtBottom);
  const got = fen.placementFromMatrix(oriented);
  const ok = got === f.placement && orientation.whiteAtBottom === f.whiteAtBottom;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${f.file} conf=${rec.confidence.toFixed(2)} det=${d.score.toFixed(3)}`);
  if (!ok && mode !== 'quiet') {
    console.log(`  rect got ${JSON.stringify(d.rect)} want ${JSON.stringify(f.boardRect)}`);
    console.log(`  orient got wB=${orientation.whiteAtBottom} want wB=${f.whiteAtBottom}`);
    console.log(`  got  ${got}`);
    console.log(`  want ${f.placement}`);
    if (mode === 'cells') {
      const wantScreen = fen.orientMatrix(fen.placementToMatrix(f.placement), f.whiteAtBottom);
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const w = wantScreen[r][c], g = rec.board[r][c];
          if (w !== g) {
            const cell = rec.cells[r][c];
            console.log(`    cell r${r}c${c}: want ${w} got ${g} score=${cell.score.toFixed(3)} margin=${cell.margin.toFixed(3)}`);
          }
        }
      }
    }
  }
}
