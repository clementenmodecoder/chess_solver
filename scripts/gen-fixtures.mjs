/** Generate synthetic chessboard screenshots for the vision test-suite.
 *  Boards are composited from the bundled SVG piece sets over various square
 *  color themes, sizes, orientations, with optional page margins, move
 *  highlights and coordinate labels. Output: tests/fixtures/*.png + index.json */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePng } from './lib/util.mjs';
import { renderBoard, THEMES, POSITIONS } from './lib/boardgen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'tests/fixtures');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const fixtures = [];
function emit(name, cfg) {
  const { img, boardRect } = renderBoard(cfg);
  writePng(resolve(outDir, `${name}.png`), img);
  fixtures.push({
    file: `${name}.png`,
    placement: cfg.placement,
    whiteAtBottom: cfg.whiteAtBottom,
    boardRect,
    set: cfg.set,
    theme: cfg.theme,
    holdout: cfg.holdout ?? false,
  });
}

// --- Template sets: all positions, mixed themes/sizes/orientations ----------
const templateSets = ['cburnett', 'merida', 'chessnut', 'fantasy', 'rhosgfx'];
const themeNames = Object.keys(THEMES);
const positions = Object.entries(POSITIONS);
let i = 0;
for (const set of templateSets) {
  for (const [posName, placement] of positions) {
    const theme = themeNames[i % themeNames.length];
    const boardSize = [256, 512, 600, 328, 456][i % 5];
    const whiteAtBottom = i % 2 === 0;
    emit(`${set}-${posName}-${theme}-${boardSize}${whiteAtBottom ? '' : '-flipped'}`, {
      placement, set, theme, boardSize, whiteAtBottom,
      margin: 0,
    });
    i++;
  }
}

// --- Holdout set (spatial): never used for shape templates ------------------
for (const [posName, placement] of positions) {
  const theme = themeNames[i % themeNames.length];
  emit(`holdout-spatial-${posName}-${theme}`, {
    placement, set: 'spatial', theme, boardSize: 512, whiteAtBottom: i % 2 === 0,
    holdout: true,
  });
  i++;
}

// --- Special cases -----------------------------------------------------------
emit('special-margin-scan', {
  placement: POSITIONS.middlegame, set: 'cburnett', theme: 'green',
  boardSize: 480, whiteAtBottom: true, margin: 160, clutterSeed: 42,
});
emit('special-margin-scan-flipped', {
  placement: POSITIONS.tactics, set: 'merida', theme: 'brown',
  boardSize: 400, whiteAtBottom: false, margin: 200, clutterSeed: 1337,
});
emit('special-tiny', {
  placement: POSITIONS.start, set: 'cburnett', theme: 'brown',
  boardSize: 192, whiteAtBottom: true,
});
emit('special-large', {
  placement: POSITIONS.tactics, set: 'chessnut', theme: 'blue',
  boardSize: 800, whiteAtBottom: true,
});
emit('special-highlight', {
  placement: POSITIONS.middlegame, set: 'cburnett', theme: 'green',
  boardSize: 512, whiteAtBottom: true,
  highlight: [[4, 2], [6, 1]],
});
emit('special-coords', {
  placement: POSITIONS.start, set: 'merida', theme: 'brown',
  boardSize: 512, whiteAtBottom: true, coords: true,
});
emit('special-highlight-coords-small', {
  placement: POSITIONS.tactics, set: 'chessnut', theme: 'walnut',
  boardSize: 288, whiteAtBottom: false, coords: true, highlight: [[2, 4], [3, 3]],
});

writeFileSync(resolve(outDir, 'index.json'), JSON.stringify(fixtures, null, 2));
console.log(`wrote ${fixtures.length} fixtures to ${outDir}`);
