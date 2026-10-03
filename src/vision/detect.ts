/** Chessboard localization inside a screenshot.
 *
 *  Two paths, both purely visual:
 *   - `verifyCandidate` scores a rectangle proposed by DOM heuristics
 *     (square-ish elements) and refines its geometry locally;
 *   - `scanForBoard` is the fallback: a multi-scale sliding-window search
 *     over the whole image using an integral image, looking for the
 *     strongest 8x8 alternating two-color pattern.
 */

import type { RGBAImage, Rect, DetectedBoard } from './types';
import { buildIntegral, colorDist, downscale, medianColor, rectMean, type IntegralImage } from './image';

export const MIN_CHECKER_CONTRAST = 10; // RGB distance between light/dark squares
export const MIN_CHECKER_SCORE = 0.55;

/** Checkerboard score of `rect` in `img`.
 *  For each of the 64 cells we estimate the square background color from its
 *  four corner patches (taking the closest pair, robust to a piece), then
 *  measure how well colors split into two alternating parity groups. */
export function checkerScore(img: RGBAImage, rect: Rect): { score: number; contrast: number } {
  const it = buildIntegralCached(img);
  return checkerScoreIntegral(it, rect);
}

const integralCache = new WeakMap<RGBAImage, IntegralImage>();
function buildIntegralCached(img: RGBAImage): IntegralImage {
  let it = integralCache.get(img);
  if (!it) {
    it = buildIntegral(img);
    integralCache.set(img, it);
  }
  return it;
}

function cellBackground(it: IntegralImage, x0: number, y0: number, cw: number, ch: number): [number, number, number] {
  const px = Math.max(2, cw * 0.2);
  const py = Math.max(2, ch * 0.2);
  const x1 = x0 + cw, y1 = y0 + ch;
  const corners: [number, number, number][] = [
    rectMean(it, x0, y0, x0 + px, y0 + py),
    rectMean(it, x1 - px, y0, x1, y0 + py),
    rectMean(it, x0, y1 - py, x0 + px, y1),
    rectMean(it, x1 - px, y1 - py, x1, y1),
  ];
  let best = Infinity;
  let bg = corners[0];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const d = colorDist(...corners[i], ...corners[j]);
      if (d < best) {
        best = d;
        bg = [
          (corners[i][0] + corners[j][0]) / 2,
          (corners[i][1] + corners[j][1]) / 2,
          (corners[i][2] + corners[j][2]) / 2,
        ];
      }
    }
  }
  return bg;
}

function checkerScoreIntegral(it: IntegralImage, rect: Rect): { score: number; contrast: number } {
  const cw = rect.w / 8;
  const ch = rect.h / 8;
  if (cw < 6 || ch < 6) return { score: 0, contrast: 0 };
  const groupA: [number, number, number][] = [];
  const groupB: [number, number, number][] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const bg = cellBackground(it, rect.x + c * cw, rect.y + r * ch, cw, ch);
      ((r + c) % 2 === 0 ? groupA : groupB).push(bg);
    }
  }
  const medA = medianColor(groupA);
  const medB = medianColor(groupB);
  const contrast = colorDist(...medA, ...medB);
  const spread = (group: [number, number, number][], med: [number, number, number]) =>
    group.reduce((s, col) => s + colorDist(...col, ...med), 0) / group.length;
  const spreadA = spread(groupA, medA);
  const spreadB = spread(groupB, medB);
  const score = contrast / (contrast + 2 * (spreadA + spreadB) + 8);
  return { score, contrast };
}

/** Local hill-climb around a candidate rect (shift up to ~5%, scale ±6%). */
export function refineRect(img: RGBAImage, rect: Rect): DetectedBoard {
  const it = buildIntegralCached(img);
  let best: Rect = { ...rect };
  let bestScore = checkerScoreIntegral(it, best).score;
  const steps = [0.02, 0.01, 0.004];
  for (const step of steps) {
    let improved = true;
    while (improved) {
      improved = false;
      const s = Math.max(1, best.w * step);
      const variants: Rect[] = [
        { ...best, x: best.x - s },
        { ...best, x: best.x + s },
        { ...best, y: best.y - s },
        { ...best, y: best.y + s },
        { x: best.x - s / 2, y: best.y - s / 2, w: best.w + s, h: best.h + s },
        { x: best.x + s / 2, y: best.y + s / 2, w: best.w - s, h: best.h - s },
      ];
      for (const v of variants) {
        if (v.w < 48 || v.h < 48) continue;
        if (v.x < -v.w * 0.02 || v.y < -v.h * 0.02) continue;
        if (v.x + v.w > img.width * 1.02 || v.y + v.h > img.height * 1.02) continue;
        const { score } = checkerScoreIntegral(it, v);
        if (score > bestScore + 1e-4) {
          bestScore = score;
          best = v;
          improved = true;
        }
      }
    }
  }
  return { rect: best, score: bestScore };
}

/** Sum of color transitions across the 14 internal grid lines. Sharp peak at
 *  exact grid alignment, used for sub-cell refinement (the corner-patch
 *  checker score is flat within a few pixels). */
function edgeAlignScore(img: RGBAImage, rect: Rect): number {
  const S = 32;
  const d = Math.max(1.0, (rect.w / 8) * 0.03);
  const { data, width, height } = img;
  const read = (x: number, y: number): [number, number, number] => {
    const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
    const i = (yi * width + xi) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // Per-line MEDIAN of sample transitions, then summed over the 14 internal
  // lines: at exact alignment nearly every sample is a light/dark square
  // transition, while misalignment yields ~zero for most samples. The median
  // resists the large gradients pieces produce away from the true grid.
  let score = 0;
  const vDiffs = new Array<number>(S);
  const hDiffs = new Array<number>(S);
  for (let k = 1; k < 8; k++) {
    const lx = rect.x + (k * rect.w) / 8;
    const ly = rect.y + (k * rect.h) / 8;
    for (let s = 0; s < S; s++) {
      const t = (s + 0.5) / S;
      const y = rect.y + t * rect.h;
      const x = rect.x + t * rect.w;
      const a = read(lx - d, y);
      const b = read(lx + d, y);
      vDiffs[s] = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      const c = read(x, ly - d);
      const e = read(x, ly + d);
      hDiffs[s] = Math.abs(c[0] - e[0]) + Math.abs(c[1] - e[1]) + Math.abs(c[2] - e[2]);
    }
    vDiffs.sort((p, q) => p - q);
    hDiffs.sort((p, q) => p - q);
    score += vDiffs[S >> 1] + hDiffs[S >> 1];
  }
  return score;
}

/** Pattern search over (x, y, w, h) maximizing internal grid-edge alignment. */
export function refineGridAlignment(img: RGBAImage, rect: Rect): Rect {
  let best: Rect = { ...rect };
  let bestScore = edgeAlignScore(img, best);
  const cell = rect.w / 8;
  const maxDrift = cell * 0.75;
  const orig = { ...rect };
  const steps = [cell * 0.12, cell * 0.05, cell * 0.02, 0.5];
  for (const step of steps) {
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 40) {
      improved = false;
      // Translations plus independent edge moves (left/right/top/bottom).
      const variants: Rect[] = [
        { ...best, x: best.x - step },
        { ...best, x: best.x + step },
        { ...best, y: best.y - step },
        { ...best, y: best.y + step },
        { ...best, x: best.x - step, w: best.w + step },
        { ...best, x: best.x + step, w: best.w - step },
        { ...best, w: best.w - step },
        { ...best, w: best.w + step },
        { ...best, y: best.y - step, h: best.h + step },
        { ...best, y: best.y + step, h: best.h - step },
        { ...best, h: best.h - step },
        { ...best, h: best.h + step },
      ];
      for (const v of variants) {
        if (Math.abs(v.x - orig.x) > maxDrift || Math.abs(v.y - orig.y) > maxDrift) continue;
        if (Math.abs(v.w - orig.w) > maxDrift * 2 || Math.abs(v.h - orig.h) > maxDrift * 2) continue;
        if (v.w < 48 || v.h < 48) continue;
        const s = edgeAlignScore(img, v);
        if (s > bestScore * 1.0005) {
          bestScore = s;
          best = v;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** Final sub-pixel polish: localize each of the 9 grid boundary lines per axis
 *  by gradient argmax, then robustly fit (offset, cellSize) via medians. */
export function snapGrid(img: RGBAImage, rect: Rect): Rect {
  const { data, width, height } = img;
  const bilinear = (x: number, y: number, ch: number): number => {
    const x0 = Math.max(0, Math.min(width - 2, Math.floor(x)));
    const y0 = Math.max(0, Math.min(height - 2, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - x0));
    const fy = Math.min(1, Math.max(0, y - y0));
    const i00 = (y0 * width + x0) * 4 + ch;
    const i10 = i00 + 4;
    const i01 = i00 + width * 4;
    const i11 = i01 + 4;
    return (
      data[i00] * (1 - fx) * (1 - fy) +
      data[i10] * fx * (1 - fy) +
      data[i01] * (1 - fx) * fy +
      data[i11] * fx * fy
    );
  };
  const S = 24;

  const snapAxis = (vertical: boolean): { offset: number; cell: number } | null => {
    const cell = vertical ? rect.w / 8 : rect.h / 8;
    const base = vertical ? rect.x : rect.y;
    const radius = Math.max(2, cell * 0.12);
    const found: { k: number; pos: number; strength: number }[] = [];
    for (let k = 0; k <= 8; k++) {
      const center = base + k * cell;
      let bestPos = center;
      let bestStrength = -1;
      for (let o = -radius; o <= radius; o += 0.5) {
        const p = center + o;
        const diffs: number[] = [];
        for (let s = 0; s < S; s++) {
          const t = vertical
            ? rect.y + ((s + 0.5) / S) * rect.h
            : rect.x + ((s + 0.5) / S) * rect.w;
          let diff = 0;
          for (const ch of [0, 1, 2]) {
            diff += vertical
              ? Math.abs(bilinear(p + 0.75, t, ch) - bilinear(p - 0.75, t, ch))
              : Math.abs(bilinear(t, p + 0.75, ch) - bilinear(t, p - 0.75, ch));
          }
          diffs.push(diff);
        }
        diffs.sort((a, b) => a - b);
        const strength = diffs[S >> 1];
        if (strength > bestStrength) {
          bestStrength = strength;
          bestPos = p;
        }
      }
      found.push({ k, pos: bestPos, strength: bestStrength });
    }
    // Internal lines are the trustworthy ones; outer edges may border
    // arbitrary page background.
    const internal = found.filter((f) => f.k >= 1 && f.k <= 7);
    const strengths = internal.map((f) => f.strength).sort((a, b) => a - b);
    const medStrength = strengths[strengths.length >> 1];
    const kept = found.filter((f) => f.strength > medStrength * 0.4);
    if (kept.length < 4) return null;
    const slopes: number[] = [];
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        slopes.push((kept[j].pos - kept[i].pos) / (kept[j].k - kept[i].k));
      }
    }
    slopes.sort((a, b) => a - b);
    const cellFit = slopes[slopes.length >> 1];
    if (!(cellFit > cell * 0.8 && cellFit < cell * 1.25)) return null;
    const offsets = kept.map((f) => f.pos - f.k * cellFit).sort((a, b) => a - b);
    const offsetFit = offsets[offsets.length >> 1];
    return { offset: offsetFit, cell: cellFit };
  };

  const xFit = snapAxis(true);
  const yFit = snapAxis(false);
  if (!xFit || !yFit) return rect;
  return { x: xFit.offset, y: yFit.offset, w: xFit.cell * 8, h: yFit.cell * 8 };
}

/** Force a near-square rect to an exact square around its center (boards are
 *  square; a 0.3% aspect error puts the far rows a full pixel off). */
export function squarify(rect: Rect): Rect {
  if (Math.abs(rect.w - rect.h) > Math.max(rect.w, rect.h) * 0.02) return rect;
  const s = (rect.w + rect.h) / 2;
  return { x: rect.x + (rect.w - s) / 2, y: rect.y + (rect.h - s) / 2, w: s, h: s };
}

/** Score a DOM-proposed rect; returns refined rect or null if it does not look
 *  like a chessboard. */
export function verifyCandidate(img: RGBAImage, rect: Rect): DetectedBoard | null {
  const clamped: Rect = {
    x: Math.max(0, rect.x),
    y: Math.max(0, rect.y),
    w: Math.min(rect.w, img.width - Math.max(0, rect.x)),
    h: Math.min(rect.h, img.height - Math.max(0, rect.y)),
  };
  if (clamped.w < 48 || clamped.h < 48) return null;
  const coarse = refineRect(img, clamped);
  // Enforce the square aspect a chessboard always has: a 0.3% aspect error
  // from soft, textured square edges puts the far rows a full pixel off.
  const aligned = squarify(snapGrid(img, refineGridAlignment(img, coarse.rect)));
  const { score, contrast } = checkerScore(img, aligned);
  if (score < MIN_CHECKER_SCORE || contrast < MIN_CHECKER_CONTRAST) return null;
  return { rect: aligned, score };
}

interface CombCandidate {
  offset: number;
  cell: number;
  score: number;
}

/** Find "combs" of 9 evenly spaced gradient peaks in a 1D projection:
 *  candidate (offset, cellSize) pairs for one axis of the grid. */
function findCombs(proj: Float64Array, len: number): CombCandidate[] {
  // Cap huge single edges so one page border cannot dominate a wrong comb
  // (kept high enough that genuine grid lines do not saturate, or the comb
  // search loses its gradient and cannot rank/refine candidates).
  let mean = 0;
  for (let i = 0; i < len; i++) mean += proj[i];
  mean /= len;
  const cap = mean * 12;
  const p = new Float64Array(len);
  for (let i = 0; i < len; i++) p[i] = Math.min(proj[i], cap);
  const peakAt = (x: number): number => {
    const xi = Math.round(x);
    let best = 0;
    for (let d = -2; d <= 2; d++) {
      const i = xi + d;
      if (i >= 0 && i < len && p[i] > best) best = p[i];
    }
    return best;
  };

  const cands: CombCandidate[] = [];
  const minCell = Math.max(12, (len / 8) * 0.14);
  const maxCell = len / 8;
  for (let cell = maxCell; cell >= minCell; cell *= 0.97) {
    const step = Math.max(1, cell / 24);
    const perCell: { offset: number; score: number }[] = [];
    for (let offset = 0; offset + 8 * cell <= len + 2; offset += step) {
      let s = 0;
      for (let k = 0; k <= 8; k++) s += peakAt(offset + k * cell);
      perCell.push({ offset, score: s });
    }
    perCell.sort((a, b) => b.score - a.score);
    // Keep a few distinct offsets per cell size: grid aliasing (offset one
    // full cell off) can narrowly outscore the true offset near clutter.
    const kept: { offset: number; score: number }[] = [];
    for (const c of perCell) {
      if (kept.length >= 3) break;
      if (kept.some((k) => Math.abs(k.offset - c.offset) < cell * 0.45)) continue;
      kept.push(c);
    }
    for (const k of kept) {
      if (k.score > 0) cands.push({ offset: k.offset, cell, score: k.score / 9 });
    }
  }

  // Local refinement of (offset, cell): the size ladder is coarse, and a
  // cell-size error of <1% accumulates to several pixels by the 9th line.
  for (const c of cands) {
    let bestScore = -1;
    const evalComb = (offset: number, cell: number) => {
      let s = 0;
      for (let k = 0; k <= 8; k++) s += peakAt(offset + k * cell);
      return s;
    };
    bestScore = evalComb(c.offset, c.cell);
    for (const step of [1, 0.4, 0.15]) {
      let improved = true;
      let guard = 0;
      while (improved && guard++ < 30) {
        improved = false;
        for (const [dOff, dCell] of [[-step, 0], [step, 0], [0, -step / 8], [0, step / 8]] as const) {
          const off = c.offset + dOff;
          const cell = c.cell + dCell;
          if (off < 0 || off + 8 * cell > len + 2) continue;
          const s = evalComb(off, cell);
          if (s > bestScore) {
            bestScore = s;
            c.offset = off;
            c.cell = cell;
            improved = true;
          }
        }
      }
    }
    c.score = bestScore / 9;
  }
  cands.sort((a, b) => b.score - a.score);
  // Non-max suppression on (offset, cell).
  const kept: CombCandidate[] = [];
  for (const c of cands) {
    if (kept.length >= 8) break;
    if (
      kept.some(
        (k) => Math.abs(k.cell - c.cell) < Math.max(k.cell, c.cell) * 0.12 && Math.abs(k.offset - c.offset) < k.cell,
      )
    ) {
      continue;
    }
    kept.push(c);
  }
  return kept;
}

/** Full-image fallback search: 1D gradient projections + comb matching to
 *  propose grid geometries, then precise verification/refinement.
 *  (A sliding-window checker score is far too alignment-sensitive.) */
export function scanForBoard(fullImg: RGBAImage): DetectedBoard | null {
  const { img, scale } = downscale(fullImg, 800);
  const { data, width, height } = img;

  // Luminance plane.
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  // Gradient projections.
  const px = new Float64Array(width);
  const py = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      px[x] += Math.abs(lum[y * width + x + 1] - lum[y * width + x]);
    }
  }
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      py[y] += Math.abs(lum[(y + 1) * width + x] - lum[y * width + x]);
    }
  }

  const xCombs = findCombs(px, width);
  const yCombs = findCombs(py, height);

  let best: DetectedBoard | null = null;
  let tried = 0;
  outer: for (const xc of xCombs) {
    for (const yc of yCombs) {
      // The grid must be square-ish.
      if (Math.abs(xc.cell - yc.cell) > Math.max(xc.cell, yc.cell) * 0.06) continue;
      if (tried++ > 24) break outer;
      const fullRect: Rect = {
        x: xc.offset / scale,
        y: yc.offset / scale,
        w: (xc.cell * 8) / scale,
        h: (yc.cell * 8) / scale,
      };
      const coarse = refineRect(fullImg, fullRect);
      const aligned = snapGrid(fullImg, refineGridAlignment(fullImg, coarse.rect));
      const { score, contrast } = checkerScore(fullImg, aligned);
      if (score < MIN_CHECKER_SCORE || contrast < MIN_CHECKER_CONTRAST) continue;
      // Larger boards win ties: prefer area when scores are close.
      const effective = score + Math.min(0.08, (aligned.w / fullImg.width) * 0.08);
      if (!best || effective > best.score) best = { rect: aligned, score: effective };
    }
  }
  return best;
}

/** Main entry: try DOM hints first, then the full scan. */
export function detectBoard(img: RGBAImage, hints: Rect[] = []): DetectedBoard | null {
  let best: DetectedBoard | null = null;
  for (const hint of hints) {
    const v = verifyCandidate(img, hint);
    if (v && (!best || v.score > best.score)) best = v;
  }
  if (best) return best;
  return scanForBoard(img);
}
