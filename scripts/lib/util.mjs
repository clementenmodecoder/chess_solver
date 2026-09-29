import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';

/** Bundle a TS module on the fly and import it (for scripts sharing src/ code). */
export async function importTs(entry) {
  const out = await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: [],
    loader: { '.json': 'json' },
  });
  const dir = mkdtempSync(join(tmpdir(), 'ts-import-'));
  const file = join(dir, 'mod.mjs');
  writeFileSync(file, out.outputFiles[0].contents);
  return import(pathToFileURL(file).href);
}

/** Render an SVG file to RGBA at the given square size (fit longest side). */
export function renderSvg(svgPath, size) {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const rendered = resvg.render();
  return {
    data: new Uint8ClampedArray(rendered.pixels),
    width: rendered.width,
    height: rendered.height,
  };
}

export function readPng(path) {
  const png = PNG.sync.read(readFileSync(path));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

export function writePng(path, img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}
