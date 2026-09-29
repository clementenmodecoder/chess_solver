/** Adaptive template learning: harvesting silhouettes from a validated scan
 *  on one board must fix recognition of the same piece style in harder
 *  conditions (different position + textured squares). */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { RGBAImage, Rect } from '../src/vision/types';
import { detectBoard } from '../src/vision/detect';
import { classifyBoard } from '../src/vision/classify';
import { loadTemplates } from '../src/vision/templates';
import { harvestIntoStore, learnedToTemplates, type LearnedStore } from '../src/vision/learning';
import { crop } from '../src/vision/image';
import { decideOrientation, orientMatrix, placementFromMatrix } from '../src/chess/fen';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, 'fixtures');

interface Fixture {
  file: string;
  placement: string;
  whiteAtBottom: boolean;
  boardRect: Rect;
}

function readPng(path: string): RGBAImage {
  const png = PNG.sync.read(readFileSync(path));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

function recognize(f: Fixture, extra = [] as ReturnType<typeof learnedToTemplates>) {
  const img = readPng(resolve(fixtureDir, f.file));
  const detected = detectBoard(img, [f.boardRect])!;
  expect(detected).not.toBeNull();
  const rec = classifyBoard(crop(img, detected.rect), [...loadTemplates(), ...extra]);
  const o = decideOrientation(rec.board);
  return { rec, placement: placementFromMatrix(orientMatrix(rec.board, o.whiteAtBottom)) };
}

describe('adaptive template learning', () => {
  it('learning from a clean scan fixes the same style on textured squares', () => {
    const fixtures: Fixture[] = JSON.parse(readFileSync(resolve(fixtureDir, 'index.json'), 'utf8'));
    const cleanFixtures = fixtures.filter(
      (f) => f.file.includes('holdout-spatial') && !f.file.includes('wood'),
    );
    const hard = fixtures.find((f) => f.file === 'holdout-spatial-tactics-wood.png')!;
    expect(cleanFixtures.length).toBeGreaterThan(1);
    expect(hard).toBeDefined();

    // Harvest silhouettes from clean spatial boards (as the extension does
    // after each validated scan).
    const store: LearnedStore = {};
    for (const f of cleanFixtures) {
      const { rec, placement } = recognize(f);
      if (placement === f.placement) {
        harvestIntoStore(store, rec);
      }
    }
    expect(Object.keys(store).length).toBeGreaterThanOrEqual(4);

    // The learned templates must make the hard combination exact.
    const withLearned = recognize(hard, learnedToTemplates(store));
    expect(withLearned.placement).toBe(hard.placement);
  });
});
