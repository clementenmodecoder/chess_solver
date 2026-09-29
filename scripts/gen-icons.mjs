/** Generate extension icons: the cburnett white knight on a rounded dark
 *  square (GPLv2+ artwork by Colin M.L. Burnett, see assets/pieces/LICENSES.md). */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'assets/icons');
mkdirSync(outDir, { recursive: true });

const knight = readFileSync(resolve(root, 'assets/pieces/cburnett/wN.svg'), 'utf8')
  .replace(/<\?xml[^>]*\?>/, '');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3d6b48"/>
      <stop offset="1" stop-color="#24402b"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="26" fill="url(#bg)"/>
  <rect x="14" y="14" width="50" height="50" rx="6" fill="#e9e5d8" opacity="0.16"/>
  <rect x="64" y="64" width="50" height="50" rx="6" fill="#e9e5d8" opacity="0.16"/>
  <g transform="translate(19,19) scale(2)">
    ${knight}
  </g>
</svg>`;

for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(resolve(outDir, `icon${size}.png`), png);
}
console.log('icons written to assets/icons/');
