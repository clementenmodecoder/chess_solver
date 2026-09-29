/** End-to-end vision tests over the generated synthetic fixtures:
 *  board detection (with and without hints) + full recognition to FEN. */

import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { RGBAImage, Rect } from '../src/vision/types';
import { detectBoard, scanForBoard, verifyCandidate } from '../src/vision/detect';
import { classifyBoard } from '../src/vision/classify';
import { crop } from '../src/vision/image';
import { decideOrientation, orientMatrix, placementFromMatrix, placementToMatrix, validatePosition } from '../src/chess/fen';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, 'fixtures');

interface Fixture {
  file: string;
  placement: string;
  whiteAtBottom: boolean;
  boardRect: Rect;
  set: string;
  theme: string;
  holdout: boolean;
}

function readPng(path: string): RGBAImage {
  const png = PNG.sync.read(readFileSync(path));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

let fixtures: Fixture[] = [];

beforeAll(() => {
  const indexPath = resolve(fixtureDir, 'index.json');
  if (!existsSync(indexPath)) {
    throw new Error('fixtures missing - run `npm run gen:fixtures` first');
  }
  fixtures = JSON.parse(readFileSync(indexPath, 'utf8'));
});

function rectClose(a: Rect, b: Rect, tolFrac: number): boolean {
  const tol = Math.max(a.w, a.h) * tolFrac;
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.w - b.w) <= tol &&
    Math.abs(a.h - b.h) <= tol
  );
}

function recognizeFixture(f: Fixture, useHint: boolean) {
  const img = readPng(resolve(fixtureDir, f.file));
  // Simulate an imprecise DOM hint (a few px off).
  const hint: Rect = {
    x: f.boardRect.x - 3,
    y: f.boardRect.y + 2,
    w: f.boardRect.w + 4,
    h: f.boardRect.h - 1,
  };
  const detected = useHint ? detectBoard(img, [hint]) : detectBoard(img, []);
  expect(detected, `board not detected in ${f.file}`).not.toBeNull();
  expect(
    rectClose(detected!.rect, f.boardRect, 0.02),
    `rect mismatch in ${f.file}: got ${JSON.stringify(detected!.rect)} want ${JSON.stringify(f.boardRect)}`,
  ).toBe(true);

  const boardImg = crop(img, detected!.rect);
  const rec = classifyBoard(boardImg);
  const orientation = decideOrientation(rec.board);
  const oriented = orientMatrix(rec.board, orientation.whiteAtBottom);
  return { rec, orientation, placement: placementFromMatrix(oriented) };
}

describe('board detection + recognition (template piece sets)', () => {
  it('recognizes every non-holdout fixture exactly (with DOM hint)', () => {
    const failures: string[] = [];
    for (const f of fixtures.filter((f) => !f.holdout)) {
      const { orientation, placement } = recognizeFixture(f, true);
      if (orientation.whiteAtBottom !== f.whiteAtBottom) {
        failures.push(`${f.file}: orientation wrong`);
        continue;
      }
      if (placement !== f.placement) {
        failures.push(`${f.file}:\n  got  ${placement}\n  want ${f.placement}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('validation passes on recognized positions', () => {
    for (const f of fixtures.filter((f) => !f.holdout).slice(0, 6)) {
      const { rec, orientation } = recognizeFixture(f, true);
      const oriented = orientMatrix(rec.board, orientation.whiteAtBottom);
      const v = validatePosition(oriented);
      expect(v.ok, `${f.file}: ${v.errors.join(', ')}`).toBe(true);
    }
  });

  it('reports reasonable confidence on clean fixtures', () => {
    const f = fixtures.find((x) => x.file.startsWith('cburnett-start'))!;
    const { rec } = recognizeFixture(f, true);
    expect(rec.confidence).toBeGreaterThan(0.5);
  });
});

describe('holdout piece set (never seen as template)', () => {
  it('generalizes to an unseen piece style', () => {
    const holdouts = fixtures.filter((f) => f.holdout);
    expect(holdouts.length).toBeGreaterThan(0);
    let totalCells = 0;
    let wrongCells = 0;
    for (const f of holdouts) {
      const img = readPng(resolve(fixtureDir, f.file));
      const detected = detectBoard(img, [f.boardRect]);
      expect(detected, `board not detected in ${f.file}`).not.toBeNull();
      const rec = classifyBoard(crop(img, detected!.rect));
      const orientation = decideOrientation(rec.board);
      const oriented = orientMatrix(rec.board, orientation.whiteAtBottom);
      const got = placementFromMatrix(oriented);
      // Cell-level accuracy comparison in white perspective.
      const wantM = placementToMatrix(f.placement);
      const gotM = placementToMatrix(got);
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          totalCells++;
          if (wantM[r][c] !== gotM[r][c]) wrongCells++;
        }
      }
    }
    const accuracy = 1 - wrongCells / totalCells;
    expect(accuracy, `holdout accuracy ${(accuracy * 100).toFixed(1)}%`).toBeGreaterThan(0.97);
  });
});

describe('detection without hints (full-image scan)', () => {
  it('finds the board inside a cluttered page', () => {
    for (const name of ['special-margin-scan.png', 'special-margin-scan-flipped.png']) {
      const f = fixtures.find((x) => x.file === name)!;
      const img = readPng(resolve(fixtureDir, f.file));
      const detected = scanForBoard(img);
      expect(detected, `scan failed for ${name}`).not.toBeNull();
      expect(
        rectClose(detected!.rect, f.boardRect, 0.03),
        `${name}: got ${JSON.stringify(detected!.rect)} want ${JSON.stringify(f.boardRect)}`,
      ).toBe(true);
    }
  });

  it('rejects a hint region that is not a chessboard', () => {
    const f = fixtures.find((x) => x.file === 'special-margin-scan.png')!;
    const img = readPng(resolve(fixtureDir, f.file));
    const bogus: Rect = { x: 0, y: 0, w: 140, h: 140 };
    expect(verifyCandidate(img, bogus)).toBeNull();
  });
});
