/** Generate piece silhouette templates from the bundled SVG piece sets.
 *  Output: src/vision/templates.gen.json (committed, so builds work offline).
 *
 *  The normalization is imported from src/vision/silhouette.ts so templates
 *  and runtime silhouettes go through the exact same transform. */

import { writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs, renderSvg } from './lib/util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Piece sets embedded as recognition templates (see assets/pieces/LICENSES.md). */
const TEMPLATE_SETS = ['cburnett', 'merida', 'chessnut', 'fantasy', 'rhosgfx'];
const PIECES = ['K', 'Q', 'R', 'B', 'N', 'P'];
const COLORS = ['w', 'b'];
const RASTER_SIZE = 128;

const { normalizeSilhouette, fillHoles, TEMPLATE_SIZE } = await importTs(
  resolve(root, 'src/vision/silhouette.ts'),
);

const templates = [];
for (const set of TEMPLATE_SETS) {
  for (const color of COLORS) {
    for (const piece of PIECES) {
      const svgPath = resolve(root, `assets/pieces/${set}/${color}${piece}.svg`);
      if (!existsSync(svgPath)) {
        console.error(`missing ${svgPath}`);
        process.exit(1);
      }
      const img = renderSvg(svgPath, RASTER_SIZE);
      const { width, height, data } = img;
      const mask = new Float32Array(width * height);
      for (let i = 0; i < width * height; i++) {
        mask[i] = data[i * 4 + 3] / 255;
      }
      const filled = fillHoles(mask, width, height);
      const sil = normalizeSilhouette(filled, width, height);
      if (!sil) {
        console.error(`empty silhouette for ${set}/${color}${piece}`);
        process.exit(1);
      }
      const bytes = new Uint8Array(sil.grid.length);
      for (let i = 0; i < sil.grid.length; i++) bytes[i] = Math.round(sil.grid[i] * 255);
      templates.push({
        set,
        piece,
        color,
        grid: Buffer.from(bytes).toString('base64'),
        relHeight: Number(sil.relHeight.toFixed(4)),
        relWidth: Number(sil.relWidth.toFixed(4)),
      });
    }
  }
}

const outPath = resolve(root, 'src/vision/templates.gen.json');
writeFileSync(outPath, JSON.stringify({ size: TEMPLATE_SIZE, templates }));
console.log(`wrote ${templates.length} templates to ${outPath}`);
