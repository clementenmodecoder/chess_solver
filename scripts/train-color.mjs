/** Train the piece-color logistic model on synthetic boards rendered from all
 *  bundled piece sets, across themes / sizes / square parities.
 *  Output: src/vision/colorModel.gen.json (committed). */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs } from './lib/util.mjs';
import { renderBoard, THEMES } from './lib/boardgen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const classify = await importTs(resolve(root, 'src/vision/classify.ts'));

const SETS = ['cburnett', 'merida', 'chessnut', 'fantasy', 'rhosgfx', 'spatial'];
const SIZES = [224, 320, 512];
// Every piece type of both colors on both square parities.
const LAYOUTS = [
  'KQRBNPKQ/kqrbnpkq/QRBNPKQR/qrbnpkqr/RBNPKQRB/rbnpkqrb/BNPKQRBN/bnpkqrbn',
  'pnbrqkpn/PNBRQKPN/nbrqkpnb/NBRQKPNB/brqkpnbr/BRQKPNBR/rqkpnbrq/RQKPNBRQ',
];

const FEATURE_KEYS = ['med', 'q20', 'q80', 'fracBright', 'fracDark', 'outlineDark', 'brightPatch', 'texture'];

const samples = [];
for (const set of SETS) {
  for (const theme of Object.keys(THEMES)) {
    for (const size of SIZES) {
      for (let li = 0; li < LAYOUTS.length; li++) {
        const { img, screenMatrix } = renderBoard({
          placement: LAYOUTS[li],
          set,
          theme,
          boardSize: size,
          whiteAtBottom: true,
        });
        const analyses = classify.analyzeBoard(img);
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            const truth = screenMatrix[r][c];
            const a = analyses[r][c];
            if (!truth || !a.occupied || !a.features) continue;
            samples.push({
              set,
              x: FEATURE_KEYS.map((k) => a.features[k]),
              y: truth === truth.toUpperCase() ? 1 : 0,
            });
          }
        }
      }
    }
  }
  console.log(`${set}: ${samples.length} samples so far`);
}

// --- Logistic regression (full batch gradient descent, L2) ------------------
const n = FEATURE_KEYS.length;
let w = new Array(n).fill(0);
let b = 0;
const lr = 0.6;
const l2 = 1e-4;
const epochs = 4000;
for (let e = 0; e < epochs; e++) {
  const gw = new Array(n).fill(0);
  let gb = 0;
  for (const s of samples) {
    let z = b;
    for (let i = 0; i < n; i++) z += w[i] * s.x[i];
    const p = 1 / (1 + Math.exp(-z));
    const err = p - s.y;
    for (let i = 0; i < n; i++) gw[i] += err * s.x[i];
    gb += err;
  }
  for (let i = 0; i < n; i++) w[i] = w[i] - lr * (gw[i] / samples.length + l2 * w[i]);
  b -= lr * (gb / samples.length);
}

// --- Evaluation --------------------------------------------------------------
const bySet = new Map();
let wrong = 0;
let minMargin = Infinity;
for (const s of samples) {
  let z = b;
  for (let i = 0; i < n; i++) z += w[i] * s.x[i];
  const pred = z >= 0 ? 1 : 0;
  const stats = bySet.get(s.set) ?? { n: 0, wrong: 0 };
  stats.n++;
  if (pred !== s.y) {
    stats.wrong++;
    wrong++;
  } else {
    minMargin = Math.min(minMargin, Math.abs(z));
  }
  bySet.set(s.set, stats);
}
for (const [set, stats] of bySet) {
  console.log(`${set}: ${(100 * (1 - stats.wrong / stats.n)).toFixed(2)}% (${stats.wrong}/${stats.n} wrong)`);
}
console.log(`total: ${(100 * (1 - wrong / samples.length)).toFixed(2)}%, min correct |margin|=${minMargin.toFixed(3)}`);

const weights = {};
FEATURE_KEYS.forEach((k, i) => { weights[k] = Number(w[i].toFixed(5)); });
const out = { weights, bias: Number(b.toFixed(5)) };
writeFileSync(resolve(root, 'src/vision/colorModel.gen.json'), JSON.stringify(out, null, 2));
console.log('model:', JSON.stringify(out));
