/** Build the extension into dist/ (load it unpacked from there).
 *  Regenerates templates/color model/icons only if missing, bundles all entry
 *  points with esbuild, and copies static assets + the Stockfish engine. */

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// --test builds into dist-test/ with host permissions added so E2E tests can
// capture the tab without a user gesture. Never ship that build.
const isTest = process.argv.includes('--test');
// --dev builds into dist/ with host permissions for the sites under test and a
// dev.json that lets the extension auto-reload from a version URL
// (scripts/deploy-pc.sh). Never ship a dev build either.
const isDev = process.argv.includes('--dev');
const devVersionUrl = process.env.CHESS_LENS_DEV_URL ?? '';
const buildId = isDev ? `dev-${Date.now()}` : 'release';
const dist = resolve(root, isTest ? 'dist-test' : 'dist');

// --- Generated inputs --------------------------------------------------------
const gens = [
  ['src/vision/templates.gen.json', 'scripts/gen-templates.mjs'],
  ['src/vision/colorModel.gen.json', 'scripts/train-color.mjs'],
  ['assets/icons/icon128.png', 'scripts/gen-icons.mjs'],
];
for (const [output, script] of gens) {
  if (!existsSync(resolve(root, output))) {
    console.log(`generating ${output}…`);
    execFileSync('node', [resolve(root, script)], { stdio: 'inherit' });
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// --- Bundles -----------------------------------------------------------------
const common = {
  bundle: true,
  define: { __CHESS_LENS_BUILD__: JSON.stringify(buildId) },
  minify: true,
  sourcemap: false,
  target: ['chrome116'],
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [resolve(root, 'src/content/index.ts')],
  outfile: resolve(dist, 'content.js'),
  format: 'iife',
});
await build({
  ...common,
  entryPoints: [resolve(root, 'src/background/service-worker.ts')],
  outfile: resolve(dist, 'background.js'),
  format: 'esm',
});
await build({
  ...common,
  entryPoints: [resolve(root, 'src/offscreen/offscreen.ts')],
  outfile: resolve(dist, 'offscreen.js'),
  format: 'iife',
});
await build({
  ...common,
  entryPoints: [resolve(root, 'src/options/options.ts')],
  outfile: resolve(dist, 'options.js'),
  format: 'iife',
});
await build({
  ...common,
  entryPoints: [resolve(root, 'src/review/review.ts')],
  outfile: resolve(dist, 'review.js'),
  format: 'iife',
});

// --- Static files ------------------------------------------------------------
if (isTest) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'src/manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.name += ' (TEST BUILD)';
  writeFileSync(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
} else if (isDev) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'src/manifest.json'), 'utf8'));
  // captureVisibleTab after an automatic re-injection has no activeTab grant:
  // it needs <all_urls> (site-scoped host permissions do not satisfy it).
  manifest.host_permissions = ['<all_urls>'];
  manifest.permissions = [...manifest.permissions, 'alarms'];
  manifest.name += ' (DEV)';
  writeFileSync(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(resolve(dist, 'dev.json'), JSON.stringify({ buildId, versionUrl: devVersionUrl }, null, 2));
  writeFileSync(resolve(root, '.dev-build-id'), buildId);
} else {
  copyFileSync(resolve(root, 'src/manifest.json'), resolve(dist, 'manifest.json'));
}
copyFileSync(resolve(root, 'src/offscreen/offscreen.html'), resolve(dist, 'offscreen.html'));
copyFileSync(resolve(root, 'src/options/options.html'), resolve(dist, 'options.html'));
copyFileSync(resolve(root, 'src/review/review.html'), resolve(dist, 'review.html'));
// Piece images for the review board (cburnett, GPL-2+/CC-BY-SA, see assets/pieces/LICENSES.md).
cpSync(resolve(root, 'assets/pieces/cburnett'), resolve(dist, 'pieces'), { recursive: true });
cpSync(resolve(root, 'assets/icons'), resolve(dist, 'icons'), { recursive: true });

// --- CNN vision assets (fenshot model + onnxruntime-web wasm) ----------------
mkdirSync(resolve(dist, 'vision'), { recursive: true });
const visionAssets = [
  ['node_modules/@scoriiu/fenshot/model/chess-tiles-v2.onnx', 'chess-tiles-v2.onnx'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
];
for (const [src, name] of visionAssets) {
  const p = resolve(root, src);
  if (!existsSync(p)) {
    console.error(`Missing ${p} — run npm install first.`);
    process.exit(1);
  }
  copyFileSync(p, resolve(dist, 'vision', name));
}

// --- Engine ------------------------------------------------------------------
mkdirSync(resolve(dist, 'engine'), { recursive: true });
const engineDir = resolve(root, 'node_modules/stockfish/bin');
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  const src = resolve(engineDir, f);
  if (!existsSync(src)) {
    console.error(`Missing ${src} — run npm install first.`);
    process.exit(1);
  }
  copyFileSync(src, resolve(dist, 'engine', f));
}

console.log('\nBuild complete → dist/');
console.log('Load it via chrome://extensions → Developer mode → Load unpacked → select dist/');
