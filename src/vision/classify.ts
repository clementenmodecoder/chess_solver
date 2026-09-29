/** Per-square classification: occupancy, piece color and piece type.
 *
 *  Strategy (theme-agnostic, no site-specific assumptions):
 *   1. Estimate each square's background color from its corner patches
 *      (pieces almost never cover all four corners; we take the closest pair
 *      of corner means, which rejects up to two piece-covered corners).
 *   2. Build a soft foreground mask from color distance to the background,
 *      fill enclosed holes (handles outline-only rendering when piece fill
 *      matches the square color).
 *   3. Piece color from the median luminance of foreground pixels, clustered
 *      across the whole board (2-means) so any light/dark piece style works.
 *   4. Piece type by soft-Jaccard silhouette matching against templates from
 *      several open-source piece sets, with a small penalty on relative
 *      height mismatch (separates pawns from queens in exotic themes).
 */

import type { RGBAImage, BoardMatrix, CellClassification, RecognitionResult, PieceCode, PieceType } from './types';
import { colorDist, luminance, median, medianColor } from './image';
import { erodeMask, fillHoles, largestComponent, normalizeSilhouette, silhouetteSimilarity, type NormalizedSilhouette } from './silhouette';
import { loadTemplates, type PieceTemplate } from './templates';
import colorModel from './colorModel.gen.json';

const REL_HEIGHT_PENALTY = 0.5;
const MIN_OCCUPANCY_FILL = 0.045; // fraction of cell area that must be foreground
const MIN_TYPE_SCORE = 0.45; // below this the cell is flagged low-confidence

/** Normalized luminance/texture statistics of a piece, input to the color
 *  model. All values are scale-invariant (fractions or 0..1 luminances). */
export interface ColorFeatures {
  /** Median fill luminance (center-of-mass disk). */
  med: number;
  /** q20 / q80 fill luminance. */
  q20: number;
  q80: number;
  /** Fractions of fill pixels that are very bright / very dark. */
  fracBright: number;
  fracDark: number;
  /** Dark quantile (q25) of the outline ring. */
  outlineDark: number;
  /** Largest connected bright (>0.75) patch as a fraction of the fill area. */
  brightPatch: number;
  /** Mean absolute local luminance gradient inside the fill (texture). */
  texture: number;
}

interface CellAnalysis {
  occupied: boolean;
  /** Median luminance of the piece fill, 0..255 (kept for debugging). */
  medianLum: number;
  features: ColorFeatures | null;
  silhouette: NormalizedSilhouette | null;
}

type Color = [number, number, number];

function insetCell(x0: number, y0: number, x1: number, y1: number) {
  // Inset the cell slightly: sub-pixel grid misalignment otherwise leaks
  // slivers of neighboring squares into the mask, corrupting the silhouette
  // bounding box with full-width/height stripes.
  const inset = Math.max(1, Math.round((x1 - x0) * 0.045));
  return { x0: x0 + inset, y0: y0 + inset, x1: x1 - inset, y1: y1 - inset };
}

interface BgEstimate {
  color: Color;
  /** Mean absolute deviation of the background patches: texture/noise level. */
  noise: number;
}

/** Robust per-cell background estimate: mean colors of the four corner
 *  patches, take the average of the closest pair (rejects up to two
 *  piece-covered corners). */
function cornerBackground(img: RGBAImage, x0: number, y0: number, x1: number, y1: number): BgEstimate {
  const d = img.data;
  const p = Math.max(2, Math.round(Math.min(x1 - x0, y1 - y0) * 0.17));
  const corners: [number, number][] = [
    [x0, y0],
    [x1 - p, y0],
    [x0, y1 - p],
    [x1 - p, y1 - p],
  ];
  const cornerMeans: Color[] = corners.map(([cx, cy]) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy; y < cy + p; y++) {
      let i = (y * img.width + cx) * 4;
      for (let x = 0; x < p; x++, i += 4) {
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  });
  let best = Infinity;
  let bg: Color = cornerMeans[0];
  let pair: [number, number] = [0, 1];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const dist = colorDist(...cornerMeans[i], ...cornerMeans[j]);
      if (dist < best) {
        best = dist;
        pair = [i, j];
        bg = [
          (cornerMeans[i][0] + cornerMeans[j][0]) / 2,
          (cornerMeans[i][1] + cornerMeans[j][1]) / 2,
          (cornerMeans[i][2] + cornerMeans[j][2]) / 2,
        ];
      }
    }
  }
  // Noise level: mean absolute color deviation of the two chosen patches.
  let dev = 0, n = 0;
  for (const ci of pair) {
    const [cx, cy] = corners[ci];
    for (let y = cy; y < cy + p; y++) {
      let i = (y * img.width + cx) * 4;
      for (let x = 0; x < p; x++, i += 4) {
        dev += colorDist(d[i], d[i + 1], d[i + 2], bg[0], bg[1], bg[2]);
        n++;
      }
    }
  }
  return { color: bg, noise: n ? dev / n : 0 };
}

function buildMask(
  img: RGBAImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bg: BgEstimate,
): { mask: Float32Array; mass: number } {
  const d = img.data;
  const w = x1 - x0, h = y1 - y0;
  const mask = new Float32Array(w * h);
  // Foreground threshold adapts to the background texture: flat squares get a
  // sensitive threshold (catches light-gray piece shading on cream squares),
  // textured/wooden squares a conservative one.
  const t0 = Math.min(30, Math.max(10, bg.noise * 3.5));
  const span = 1.5 * t0;
  let mass = 0;
  for (let y = 0; y < h; y++) {
    let i = ((y0 + y) * img.width + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const dist = colorDist(d[i], d[i + 1], d[i + 2], bg.color[0], bg.color[1], bg.color[2]);
      const v = (dist - t0) / span;
      const clamped = v <= 0 ? 0 : v >= 1 ? 1 : v;
      mask[y * w + x] = clamped;
      mass += clamped;
    }
  }
  return { mask, mass };
}

function analyzeCell(
  img: RGBAImage,
  ox0: number,
  oy0: number,
  ox1: number,
  oy1: number,
  globalBg?: BgEstimate,
): CellAnalysis {
  const { x0, y0, x1, y1 } = insetCell(ox0, oy0, ox1, oy1);
  const w = x1 - x0;
  const h = y1 - y0;
  const d = img.data;

  // --- 1+2. Background candidates -> soft foreground mask ------------------
  // Bulky pieces can cover all four corner patches and poison the per-cell
  // estimate; the board-wide parity color fixes that. Conversely, per-square
  // highlights (last move, selection) break the global color. Pick whichever
  // candidate explains more of the cell as background (smaller mask mass).
  const cornerBg = cornerBackground(img, x0, y0, x1, y1);
  let { mask, mass } = buildMask(img, x0, y0, x1, y1, cornerBg);
  if (globalBg && colorDist(...globalBg.color, ...cornerBg.color) > 12) {
    const alt = buildMask(img, x0, y0, x1, y1, globalBg);
    if (alt.mass < mass) mask = alt.mask;
  }
  const filled = fillHoles(largestComponent(mask, w, h), w, h);

  // --- 3. Fill statistics for the color model -------------------------------
  // Luminance map over the fill (filled > 0.6).
  const lumMap = new Float32Array(w * h).fill(-1);
  const inFill = new Uint8Array(w * h);
  let fillCount = 0;
  for (let y = 0; y < h; y++) {
    let i = ((y0 + y) * img.width + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      if (filled[y * w + x] > 0.6) {
        lumMap[y * w + x] = luminance(d[i], d[i + 1], d[i + 2]);
        inFill[y * w + x] = 1;
        fillCount++;
      }
    }
  }

  // Interior = fill minus a light erosion (drops the outline ring).
  const ringEro = erodeMask(filled, w, h, Math.max(1, Math.round(Math.min(w, h) * 0.05)));
  const interiorLums: number[] = [];
  const ringLums: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!inFill[i]) continue;
    if (ringEro[i]) interiorLums.push(lumMap[i]);
    else ringLums.push(lumMap[i]);
  }
  // Fall back to the whole fill when the piece is too small to erode.
  const lums = interiorLums.length >= 12 ? interiorLums : [];
  if (!lums.length) {
    for (let i = 0; i < w * h; i++) if (inFill[i]) lums.push(lumMap[i]);
  }
  lums.sort((a, b) => a - b);
  ringLums.sort((a, b) => a - b);
  const q = (arr: number[], p: number) =>
    arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
  const medLum = q(lums, 0.5);
  const ringDark = ringLums.length ? q(ringLums, 0.25) : medLum;

  // Largest connected bright patch (lum > 190) within the fill.
  let brightPatch = 0;
  if (fillCount > 0) {
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let largest = 0;
    for (let start = 0; start < w * h; start++) {
      if (visited[start] || !inFill[start] || lumMap[start] <= 190) continue;
      let size = 0;
      let head = 0, tail = 0;
      visited[start] = 1;
      queue[tail++] = start;
      while (head < tail) {
        const i = queue[head++];
        size++;
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!visited[ni] && inFill[ni] && lumMap[ni] > 190) {
              visited[ni] = 1;
              queue[tail++] = ni;
            }
          }
        }
      }
      if (size > largest) largest = size;
    }
    brightPatch = largest / fillCount;
  }

  // Local texture: mean absolute horizontal/vertical luminance gradient.
  let gradSum = 0, gradN = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      if (!inFill[i]) continue;
      if (inFill[i + 1]) { gradSum += Math.abs(lumMap[i + 1] - lumMap[i]); gradN++; }
      if (inFill[i + w]) { gradSum += Math.abs(lumMap[i + w] - lumMap[i]); gradN++; }
    }
  }

  let nBright = 0, nDark = 0;
  for (const l of lums) {
    if (l > 190) nBright++;
    else if (l < 60) nDark++;
  }

  const features: ColorFeatures | null = fillCount
    ? {
        med: medLum / 255,
        q20: q(lums, 0.2) / 255,
        q80: q(lums, 0.8) / 255,
        fracBright: lums.length ? nBright / lums.length : 0,
        fracDark: lums.length ? nDark / lums.length : 0,
        outlineDark: ringDark / 255,
        brightPatch,
        texture: gradN ? gradSum / gradN / 255 : 0,
      }
    : null;

  const silhouette = normalizeSilhouette(filled, w, h);
  const occupied =
    silhouette !== null &&
    silhouette.fill >= MIN_OCCUPANCY_FILL &&
    silhouette.relHeight >= 0.28 &&
    silhouette.relWidth >= 0.15;

  return {
    occupied,
    medianLum: medLum,
    features,
    silhouette,
  };
}

/** Whiteness decision function: logistic model over ColorFeatures, trained
 *  offline on synthetic boards rendered from six very different open-source
 *  piece styles (scripts/train-color.mjs). Positive = white piece. */
export function whitenessScore(f: ColorFeatures): number {
  const m = colorModel as { weights: Record<string, number>; bias: number };
  let s = m.bias;
  for (const [k, w] of Object.entries(m.weights)) {
    s += w * (f as unknown as Record<string, number>)[k];
  }
  return s;
}

function matchType(
  sil: NormalizedSilhouette,
  templates: PieceTemplate[],
): { piece: PieceType; score: number; margin: number; typeScores: Partial<Record<PieceType, number>> } {
  const bestByType = new Map<PieceType, number>();
  for (const t of templates) {
    const sim = silhouetteSimilarity(sil.grid, t.grid) - REL_HEIGHT_PENALTY * Math.abs(sil.relHeight - t.relHeight);
    const prev = bestByType.get(t.piece);
    if (prev === undefined || sim > prev) bestByType.set(t.piece, sim);
  }
  let bestPiece: PieceType = 'P';
  let bestScore = -Infinity;
  let second = -Infinity;
  const typeScores: Partial<Record<PieceType, number>> = {};
  for (const [piece, score] of bestByType) {
    typeScores[piece] = score;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      bestPiece = piece;
    } else if (score > second) {
      second = score;
    }
  }
  return { piece: bestPiece, score: bestScore, margin: bestScore - (second === -Infinity ? 0 : second), typeScores };
}

/** Debug/test hook: analyze a single cell of a board image (r, c in 0..7). */
export function debugAnalyzeCell(boardImg: RGBAImage, r: number, c: number): CellAnalysis & {
  match?: { piece: PieceType; score: number; margin: number };
  perTemplate?: { id: string; score: number }[];
} {
  const cw = boardImg.width / 8;
  const ch = boardImg.height / 8;
  const globals = globalParityColors(boardImg);
  const a = analyzeCell(
    boardImg,
    Math.round(c * cw),
    Math.round(r * ch),
    Math.round((c + 1) * cw),
    Math.round((r + 1) * ch),
    globals[(r + c) % 2],
  );
  if (!a.silhouette) return a;
  const tpls = loadTemplates();
  const per = tpls
    .map((t) => ({
      id: `${t.set}/${t.color}${t.piece}`,
      score: silhouetteSimilarity(a.silhouette!.grid, t.grid) - REL_HEIGHT_PENALTY * Math.abs(a.silhouette!.relHeight - t.relHeight),
    }))
    .sort((x, y) => y.score - x.score);
  return { ...a, match: matchType(a.silhouette, tpls), perTemplate: per };
}

/** Median corner-based background color (and noise) for each square parity. */
function globalParityColors(boardImg: RGBAImage): [BgEstimate, BgEstimate] {
  const cw = boardImg.width / 8;
  const ch = boardImg.height / 8;
  const byParity: [BgEstimate[], BgEstimate[]] = [[], []];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const { x0, y0, x1, y1 } = insetCell(
        Math.round(c * cw),
        Math.round(r * ch),
        Math.round((c + 1) * cw),
        Math.round((r + 1) * ch),
      );
      byParity[(r + c) % 2].push(cornerBackground(boardImg, x0, y0, x1, y1));
    }
  }
  const summarize = (list: BgEstimate[]): BgEstimate => ({
    color: medianColor(list.map((e) => e.color)) as Color,
    noise: median(list.map((e) => e.noise)),
  });
  return [summarize(byParity[0]), summarize(byParity[1])];
}

/** Analyze all 64 cells of a board image (also used by the offline color
 *  model trainer). */
export function analyzeBoard(boardImg: RGBAImage): CellAnalysis[][] {
  const cw = boardImg.width / 8;
  const ch = boardImg.height / 8;
  const globals = globalParityColors(boardImg);
  const analyses: CellAnalysis[][] = [];
  for (let r = 0; r < 8; r++) {
    const row: CellAnalysis[] = [];
    for (let c = 0; c < 8; c++) {
      const x0 = Math.round(c * cw);
      const y0 = Math.round(r * ch);
      const x1 = Math.round((c + 1) * cw);
      const y1 = Math.round((r + 1) * ch);
      row.push(analyzeCell(boardImg, x0, y0, x1, y1, globals[(r + c) % 2]));
    }
    analyses.push(row);
  }
  return analyses;
}

export function classifyBoard(boardImg: RGBAImage, templates?: PieceTemplate[]): RecognitionResult {
  const tpls = templates ?? loadTemplates();
  const analyses = analyzeBoard(boardImg);

  const board: BoardMatrix = [];
  const cells: CellClassification[][] = [];
  let scoreSum = 0;
  let occupiedCount = 0;

  for (let r = 0; r < 8; r++) {
    const boardRow: (PieceCode | null)[] = [];
    const cellRow: CellClassification[] = [];
    for (let c = 0; c < 8; c++) {
      const a = analyses[r][c];
      if (!a.occupied || !a.silhouette) {
        boardRow.push(null);
        cellRow.push({ piece: null, score: 1, margin: 1 });
        continue;
      }
      const isWhite = a.features ? whitenessScore(a.features) >= 0 : a.medianLum >= 128;
      const { piece, score, margin, typeScores } = matchType(a.silhouette, tpls);
      const code = (isWhite ? piece : piece.toLowerCase()) as PieceCode;
      boardRow.push(code);
      cellRow.push({ piece: code, score, margin, typeScores });
      scoreSum += Math.max(0, Math.min(1, score));
      occupiedCount++;
    }
    board.push(boardRow);
    cells.push(cellRow);
  }

  // --- Coherence pass: at most one king per color ---------------------------
  // K/Q crowns are the most template-confusable pair; when several squares of
  // one color claim a king, keep the most king-like and demote the others to
  // their best non-king type.
  for (const kingCode of ['K', 'k'] as PieceCode[]) {
    const claims: { r: number; c: number; kingness: number }[] = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (board[r][c] !== kingCode) continue;
        const ts = cells[r][c].typeScores ?? {};
        let bestOther = -Infinity;
        for (const [p, s] of Object.entries(ts)) {
          if (p !== 'K' && s !== undefined && s > bestOther) bestOther = s;
        }
        claims.push({ r, c, kingness: (ts.K ?? 0) - bestOther });
      }
    }
    if (claims.length > 1) {
      claims.sort((a, b) => b.kingness - a.kingness);
      for (const claim of claims.slice(1)) {
        const ts = cells[claim.r][claim.c].typeScores ?? {};
        let altPiece: PieceType = 'Q';
        let altScore = -Infinity;
        for (const [p, s] of Object.entries(ts)) {
          if (p !== 'K' && s !== undefined && s > altScore) {
            altScore = s;
            altPiece = p as PieceType;
          }
        }
        const code = (kingCode === 'K' ? altPiece : altPiece.toLowerCase()) as PieceCode;
        board[claim.r][claim.c] = code;
        cells[claim.r][claim.c].piece = code;
      }
    }
  }

  const avgScore = occupiedCount ? scoreSum / occupiedCount : 0;
  // Map average silhouette score into a friendlier 0..1 confidence.
  const confidence = occupiedCount
    ? Math.max(0, Math.min(1, (avgScore - MIN_TYPE_SCORE) / (0.85 - MIN_TYPE_SCORE)))
    : 0;

  return { board, cells, confidence };
}
