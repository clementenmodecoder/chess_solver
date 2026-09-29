/** Evaluate the fenshot CNN recognizer on fixtures + real screenshots (Node). */
import { importTs } from '../../scripts/lib/util.mjs';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import * as ort from 'onnxruntime-web/wasm';

const root = resolve(import.meta.dirname, '../..');
// Bundle the ESM-extensionless package for plain Node.
const dir = mkdtempSync(join(tmpdir(), 'fenshot-'));
writeFileSync(join(dir, 'entry.ts'), "export * from '@scoriiu/fenshot';\n");
const fenshot = await importTs(join(dir, 'entry.ts'));

ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(
  readFileSync(resolve(root, 'node_modules/@scoriiu/fenshot/model/chess-tiles-v2.onnx')),
  { executionProviders: ['wasm'] },
);

export async function scanPng(pngPath) {
  const png = PNG.sync.read(readFileSync(pngPath));
  const gray = fenshot.rgbaToGray(new Uint8ClampedArray(png.data), png.width, png.height);
  const t0 = Date.now();
  const res = await fenshot.recognizeGray(gray, async (c) => {
    const tiles = fenshot.extractTiles(gray, c);
    const out = await session.run({ tiles: new ort.Tensor('float32', tiles, [64, 1024]) });
    return fenshot.probsToPlacement(out['probs'].data);
  });
  return { res, ms: Date.now() - t0 };
}

if (process.argv[1].endsWith('fenshot-eval.mjs')) {
  const targets = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        '/tmp/shot.png',
        ...['fantasy-middlegame-green-456-flipped', 'fantasy-tactics-wood-328-flipped',
            'holdout-spatial-tactics-wood', 'special-wood-coords-large', 'special-margin-scan',
            'cburnett-start-brown-256', 'special-tiny', 'special-highlight-coords-small',
            'merida-middlegame-blue-600-flipped'].map((f) => resolve(root, 'tests/fixtures', f + '.png')),
      ];
  for (const t of targets) {
    const { res, ms } = await scanPng(t);
    const name = t.split('/').pop().padEnd(44);
    if (!res) console.log(name, '-> no board', ms + 'ms');
    else console.log(name, res.reliable ? 'RELIABLE  ' : 'UNRELIABLE', 'min', res.minConfidence.toFixed(2), res.placement, ms + 'ms');
  }
}
