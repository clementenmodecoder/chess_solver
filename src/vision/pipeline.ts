/** The whole vision pipeline as one pure function over a captured frame:
 *  board localization, CNN read (injected), classical fallback with learned
 *  templates, coherence fixes, orientation and validation.
 *
 *  It runs in the extension's offscreen document, never in the page: on a
 *  real site a full-resolution capture plus silhouette matching takes
 *  hundreds of milliseconds of pure CPU, which would freeze the tab. The
 *  content script only sends geometry hints and gets back a placement. */

import type { BoardMatrix, Rect, RGBAImage } from './types';
import { detectBoard, snapGrid } from './detect';
import { classifyBoard, reconcileKingQueen } from './classify';
import { loadTemplates } from './templates';
import { harvestIntoStore, learnedToTemplates, HARVEST_MIN_CONFIDENCE, type LearnedStore } from './learning';
import { crop } from './image';
import { decideOrientation, orientMatrix, placementFromMatrix, placementToMatrix, validatePosition } from '../chess/fen';

export interface ScanRequest {
  /** Capture-space rects proposed by the page (DOM candidates, last board). */
  hints: Rect[];
  /** Capture-space rect drawn by the user; trusted, only grid-snapped. */
  manualRect: Rect | null;
  /** User-forced orientation flip. */
  orientationFlipped: boolean;
  /** Learned silhouettes for this site (read/written by the caller). */
  learned: LearnedStore;
}

export interface CnnRead {
  placement: string;
  reliable: boolean;
  minConfidence: number;
  corners?: { x0: number; y0: number; x1: number; y1: number };
}

/** Injected CNN: receives the board crop (or the whole frame when no board
 *  was localized, with `exactBoard` false). */
export type CnnReader = (img: RGBAImage, exactBoard: boolean) => Promise<CnnRead | null>;

export interface ScanResult {
  /** Board rect in capture pixels, null when nothing board-like was found. */
  rect: Rect | null;
  /** Oriented placement (ranks 8..1, White's perspective), when valid. */
  placement: string | null;
  whiteAtBottom: boolean;
  recognizer: 'cnn' | 'classic';
  confidence: number;
  lowConfidence: boolean;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  cnn: { reliable: boolean; minConfidence: number; placement?: string } | null;
  /** Screen-oriented raw read, for debugging. */
  rawPlacement: string | null;
  /** True when the learned store was updated (caller should persist it). */
  learnedUpdated: boolean;
  timings: Record<string, number>;
}

export async function runScan(img: RGBAImage, req: ScanRequest, cnn: CnnReader): Promise<ScanResult> {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = Math.round(now - t);
    t = now;
  };

  let rect: Rect | null = null;
  if (req.manualRect) {
    rect = snapGrid(img, req.manualRect);
  } else {
    rect = detectBoard(img, req.hints)?.rect ?? null;
  }
  lap('detect');

  const empty = (): ScanResult => ({
    rect,
    placement: null,
    whiteAtBottom: true,
    recognizer: 'cnn',
    confidence: 0,
    lowConfidence: true,
    validation: { ok: false, errors: ['No chessboard found'], warnings: [] },
    cnn: null,
    rawPlacement: null,
    learnedUpdated: false,
    timings,
  });

  // --- Primary recognizer: CNN on the crop (or the whole frame as fallback).
  let screenMatrix: BoardMatrix | null = null;
  let confidence = 0;
  let recognizer: 'cnn' | 'classic' = 'cnn';
  const vision = await cnn(rect ? crop(img, rect) : img, rect !== null);
  lap('cnn');
  if (vision?.reliable && vision.placement) {
    try {
      screenMatrix = placementToMatrix(vision.placement);
      confidence = vision.minConfidence;
      if (!rect && vision.corners) {
        const c = vision.corners;
        rect = { x: c.x0, y: c.y0, w: c.x1 - c.x0, h: c.y1 - c.y0 };
      }
    } catch {
      screenMatrix = null;
    }
  }
  if (!rect) return empty();

  // --- Fallback recognizer: silhouettes (bundled + learned for this site).
  let classicRec: ReturnType<typeof classifyBoard> | null = null;
  if (!screenMatrix) {
    recognizer = 'classic';
    const templates = [...loadTemplates(), ...learnedToTemplates(req.learned)];
    classicRec = classifyBoard(crop(img, rect), templates);
    if (vision?.placement) {
      try {
        reconcileKingQueen(classicRec, placementToMatrix(vision.placement));
      } catch {
        /* malformed CNN placement */
      }
    }
    screenMatrix = classicRec.board;
    confidence = classicRec.confidence;
    lap('classic');
  }

  const auto = decideOrientation(screenMatrix);
  const whiteAtBottom = req.orientationFlipped ? !auto.whiteAtBottom : auto.whiteAtBottom;
  const oriented = orientMatrix(screenMatrix, whiteAtBottom);
  const validation = validatePosition(oriented);
  let learnedUpdated = false;
  if (validation.ok && classicRec && classicRec.confidence >= HARVEST_MIN_CONFIDENCE) {
    learnedUpdated = harvestIntoStore(req.learned, classicRec);
  }
  lap('finish');

  return {
    rect,
    placement: validation.ok ? placementFromMatrix(oriented) : null,
    whiteAtBottom,
    recognizer,
    confidence,
    lowConfidence: recognizer === 'cnn' ? confidence < 0.8 : confidence < 0.45,
    validation,
    cnn: vision ? { reliable: vision.reliable, minConfidence: vision.minConfidence, placement: vision.placement } : null,
    rawPlacement: placementFromMatrix(screenMatrix),
    learnedUpdated,
    timings,
  };
}

/** Cheap content hash of a region: sampled pixel sums. Used to skip all the
 *  above when the board pixels did not change between watch-mode captures. */
export function sampleHash(img: RGBAImage, rect: Rect): number {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(img.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(img.height, Math.round(rect.y + rect.h));
  let h = 2166136261 >>> 0;
  const stepY = Math.max(1, Math.floor((y1 - y0) / 64));
  const stepX = Math.max(1, Math.floor((x1 - x0) / 64));
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * img.width + x) * 4;
      h = (h ^ img.data[i]) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
      h = (h ^ img.data[i + 1]) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h;
}
