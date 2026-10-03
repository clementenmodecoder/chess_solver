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
import { colorDist, downscale, luminance, median, medianColor } from './image';
import { erodeMask, fillHoles, largestComponent, morphOpenSupport, normalizeSilhouette, silhouetteSimilarity, type NormalizedSilhouette } from './silhouette';
import { loadTemplates, type PieceTemplate } from './templates';
import colorModel from './colorModel.gen.json';

const REL_HEIGHT_PENALTY = 0.5;
const MIN_OCCUPANCY_FILL = 0.045; // fraction of cell area that must be foreground
const MIN_BBOX_DENSITY = 0.16;
const CANONICAL_CELL = 64; // large boards are downsampled to this cell size // mask mass / bbox area: rejects thin texture streaks
const MIN_TYPE_SCORE = 0.45; // below this the cell is flagged low-confidence
const MIN_PIECE_SCORE = 0.4; // below this a foreground blob is not a piece
const RELATIVE_COLOR_MIN_GAP = 35; // luminance gap (0..255) between the two armies' clusters
const RELATIVE_COLOR_MAX_OVERRIDE = 4; // |whiteness| below which the per-board clustering may override

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

/** Mask built against a per-column background (median color of each column's
 *  top/bottom bands). Handles vertically streaked square textures. */
function buildColumnMask(
  img: RGBAImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  refBg: BgEstimate,
): { mask: Float32Array; mass: number } | null {
  const d = img.data;
  const w = x1 - x0, h = y1 - y0;
  const bandTop = Math.max(2, Math.round(h * 0.16));
  const bandBot = Math.max(2, Math.round(h * 0.12));
  if (bandTop + bandBot >= h) return null;
  const bgR = new Float32Array(w);
  const bgG = new Float32Array(w);
  const bgB = new Float32Array(w);
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const devs: number[] = [];
  for (let x = 0; x < w; x++) {
    rs.length = 0; gs.length = 0; bs.length = 0;
    for (let y = 0; y < h; y++) {
      if (y >= bandTop && y < h - bandBot) continue;
      const i = ((y0 + y) * img.width + x0 + x) * 4;
      rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    }
    bgR[x] = median(rs); bgG[x] = median(gs); bgB[x] = median(bs);
    // A column whose estimated background strays far from the cell's overall
    // background has been absorbed by a piece (rooks are column-constant!) or
    // an extreme artifact: fall back to the constant background there.
    if (colorDist(bgR[x], bgG[x], bgB[x], ...refBg.color) > 45) {
      bgR[x] = refBg.color[0]; bgG[x] = refBg.color[1]; bgB[x] = refBg.color[2];
    }
    // Column noise: mean distance of band pixels to their column median.
    let dev = 0;
    for (let k = 0; k < rs.length; k++) dev += colorDist(rs[k], gs[k], bs[k], bgR[x], bgG[x], bgB[x]);
    devs.push(dev / rs.length);
  }
  const noise = median(devs);
  const t0 = Math.min(30, Math.max(10, noise * 3.5));
  const span = 1.5 * t0;
  const mask = new Float32Array(w * h);
  let mass = 0;
  for (let y = 0; y < h; y++) {
    let i = ((y0 + y) * img.width + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const dist = colorDist(d[i], d[i + 1], d[i + 2], bgR[x], bgG[x], bgB[x]);
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
    if (alt.mass < mass) {
      mask = alt.mask;
      mass = alt.mass;
    }
  }
  // Third candidate: per-column background, estimated from the top/bottom
  // bands of each column (rarely covered by the piece). Wood-grain streaks
  // are vertical and column-constant, so each streak becomes its own
  // background and vanishes from the mask; corner coordinate labels are
  // similarly absorbed. The lowest-mass mask wins, as usual: the correct
  // background model explains more of the cell as background.
  // Only for visibly textured squares: on flat themes the constant models
  // are already exact and the column model can only nibble at pieces.
  if ((globalBg?.noise ?? cornerBg.noise) > 3.5) {
    const chosenBg =
      globalBg && colorDist(...globalBg.color, ...cornerBg.color) > 12 ? cornerBg : (globalBg ?? cornerBg);
    const colMask = buildColumnMask(img, x0, y0, x1, y1, chosenBg);
    if (colMask && colMask.mass < mass) mask = colMask.mask;
  }
  // Fill enclosed holes FIRST (outline-drawn pieces become solid bodies),
  // then, on large cells, apply a morphological opening: solid pieces
  // survive, while thin texture streaks (wood grain) and the bridges they
  // form between pieces and coordinate labels get cut. Finally keep the
  // dominant component(s) and re-fill.
  const cellMin = Math.min(w, h);
  const prefilled = fillHoles(mask, w, h);
  const cleaned =
    cellMin >= 45
      ? morphOpenSupport(prefilled, w, h, Math.max(1, Math.round(cellMin * 0.018)))
      : prefilled;
  const filled = fillHoles(largestComponent(cleaned, w, h), w, h);

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
    silhouette.relWidth >= 0.15 &&
    // Real pieces are compact; wood-grain streaks that clear the mass
    // threshold are thin and sparse within their bounding box.
    silhouette.fill / (silhouette.relHeight * silhouette.relWidth) >= MIN_BBOX_DENSITY;

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
  if (boardImg.width > 8 * CANONICAL_CELL * 1.25) boardImg = downscale(boardImg, 8 * CANONICAL_CELL).img;
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
export function analyzeBoard(rawBoardImg: RGBAImage): CellAnalysis[][] {
  // Scale normalization: very large boards are downsampled to a canonical
  // cell size. Box-averaging suppresses high-frequency square texture (wood
  // grain) that otherwise bridges coordinate labels to pieces and creates
  // phantom foreground, and it keeps processing costs flat.
  const boardImg =
    rawBoardImg.width > 8 * CANONICAL_CELL * 1.25
      ? downscale(rawBoardImg, 8 * CANONICAL_CELL).img
      : rawBoardImg;
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
      if (score < MIN_PIECE_SCORE) {
        // Foreground blob that matches no piece silhouette at all: texture
        // artifact (real pieces score well above this even in unseen styles).
        boardRow.push(null);
        cellRow.push({ piece: null, score, margin });
        continue;
      }
      const code = (isWhite ? piece : piece.toLowerCase()) as PieceCode;
      boardRow.push(code);
      cellRow.push({
        piece: code,
        score,
        margin,
        typeScores,
        silhouette: {
          grid: a.silhouette.grid,
          relHeight: a.silhouette.relHeight,
          relWidth: a.silhouette.relWidth,
        },
      });
      scoreSum += Math.max(0, Math.min(1, score));
      occupiedCount++;
    }
    board.push(boardRow);
    cells.push(cellRow);
  }

  // --- Relative color pass ---------------------------------------------------
  // The absolute whiteness model is trained on conventional light/dark piece
  // sets. Themed sets (e.g. two shades of green) can push a few borderline
  // pieces across its decision boundary. Within one board, however, the two
  // armies always form two luminance clusters: split the occupied cells in
  // two (1-D 2-means on fill luminance) and, when the clusters are clearly
  // separated, move weakly-decided pieces to the cluster they belong to.
  {
    const occupied: { r: number; c: number; lum: number; w: number }[] = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const a = analyses[r][c];
        if (board[r][c] && a.features) occupied.push({ r, c, lum: a.medianLum, w: whitenessScore(a.features) });
      }
    }
    if (occupied.length >= 4) {
      const lums = occupied.map((o) => o.lum).sort((a, b) => a - b);
      let lo = lums[0], hi = lums[lums.length - 1];
      for (let iter = 0; iter < 10; iter++) {
        let sLo = 0, nLo = 0, sHi = 0, nHi = 0;
        for (const l of lums) {
          if (Math.abs(l - lo) <= Math.abs(l - hi)) { sLo += l; nLo++; } else { sHi += l; nHi++; }
        }
        const nLo2 = nLo ? sLo / nLo : lo, nHi2 = nHi ? sHi / nHi : hi;
        if (nLo2 === lo && nHi2 === hi) break;
        lo = nLo2; hi = nHi2;
      }
      // Which cluster is white: the one the absolute model finds whiter on average.
      let wLo = 0, nLo = 0, wHi = 0, nHi = 0;
      for (const o of occupied) {
        if (Math.abs(o.lum - lo) <= Math.abs(o.lum - hi)) { wLo += o.w; nLo++; } else { wHi += o.w; nHi++; }
      }
      const hiIsWhite = nHi && nLo ? wHi / nHi >= wLo / nLo : true;
      if (hi - lo >= RELATIVE_COLOR_MIN_GAP && nLo > 0 && nHi > 0) {
        for (const o of occupied) {
          // Only pieces clearly inside one cluster may override the model;
          // anything near the midpoint is left to the absolute decision.
          const t = (o.lum - lo) / (hi - lo);
          if (t > 0.3 && t < 0.7) continue;
          const inHi = t >= 0.7;
          const relWhite = inHi ? hiIsWhite : !hiIsWhite;
          const code = board[o.r][o.c]!;
          const absWhite = code === code.toUpperCase();
          if (relWhite !== absWhite && Math.abs(o.w) < RELATIVE_COLOR_MAX_OVERRIDE) {
            const fixed = (relWhite ? code.toUpperCase() : code.toLowerCase()) as PieceCode;
            board[o.r][o.c] = fixed;
            cells[o.r][o.c].piece = fixed;
          }
        }
      }
    }
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
        // A misread king is nearly always a queen (the confusable crown pair);
        // prefer Q unless another type wins clearly.
        if (altPiece !== 'Q' && ts.Q !== undefined && ts.Q >= altScore - 0.03) altPiece = 'Q';
        const code = (kingCode === 'K' ? altPiece : altPiece.toLowerCase()) as PieceCode;
        board[claim.r][claim.c] = code;
        cells[claim.r][claim.c].piece = code;
      }
    }
  }

  // --- Coherence pass: a color with no king reclaims its best K candidate ---
  // (symmetric to the multi-king demotion: a kingless side is invalid anyway,
  // and the K/Q crown pair is the usual culprit).
  for (const white of [true, false]) {
    const kingCode = (white ? 'K' : 'k') as PieceCode;
    let hasKing = false;
    for (const row of board) for (const q of row) if (q === kingCode) hasKing = true;
    if (hasKing) continue;
    let best: { r: number; c: number; deficit: number } | null = null;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p || (p === p.toUpperCase()) !== white) continue;
        if (p.toUpperCase() !== 'Q') continue;
        const ts = cells[r][c].typeScores ?? {};
        if (ts.K === undefined || ts.Q === undefined) continue;
        const deficit = ts.Q - ts.K;
        if (deficit <= 0.05 && (!best || deficit < best.deficit)) best = { r, c, deficit };
      }
    }
    if (best) {
      board[best.r][best.c] = kingCode;
      cells[best.r][best.c].piece = kingCode;
    }
  }

  // --- Coherence pass: implausible piece counts -----------------------------
  // Three-plus bishops/knights/rooks of one color essentially never happen
  // (underpromotions are vanishingly rare); when texture artifacts inflate a
  // count, demote the weakest-margin claims to their runner-up type as long
  // as that type scored nearly as well.
  for (const white of [true, false]) {
    for (const type of ['B', 'N', 'R'] as PieceType[]) {
      const code = (white ? type : type.toLowerCase()) as PieceCode;
      const claims: { r: number; c: number; margin: number }[] = [];
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          if (board[r][c] !== code) continue;
          const ts = cells[r][c].typeScores ?? {};
          let bestOther = -Infinity;
          for (const [p, s] of Object.entries(ts)) {
            if (p !== type && s !== undefined && s > bestOther) bestOther = s;
          }
          claims.push({ r, c, margin: (ts[type] ?? 0) - bestOther });
        }
      }
      if (claims.length <= 2) continue;
      claims.sort((a, b) => b.margin - a.margin);
      const countOf = (p: PieceType): number => {
        const c2 = (white ? p : p.toLowerCase()) as PieceCode;
        let n = 0;
        for (const row of board) for (const q of row) if (q === c2) n++;
        return n;
      };
      for (const claim of claims.slice(2)) {
        if (claim.margin > 0.08) continue; // confident claim: leave it alone
        const ts = cells[claim.r][claim.c].typeScores ?? {};
        // Candidate replacement types: not the current type, not a king, and
        // not a type that is itself already at its plausible maximum
        // (otherwise two saturated types just trade the claim back and forth).
        let altPiece: PieceType | null = null;
        let altScore = -Infinity;
        for (const [p, s] of Object.entries(ts)) {
          if (p === type || p === 'K' || s === undefined) continue;
          if ((p === 'B' || p === 'N' || p === 'R') && countOf(p as PieceType) >= 2) continue;
          if (p === 'P' && countOf('P') >= 8) continue;
          if (s > altScore) {
            altScore = s;
            altPiece = p as PieceType;
          }
        }
        if (!altPiece) continue;
        // Misread empty-square artifacts and small pieces are most often
        // pawns; prefer P over a near-tied alternative.
        if (altPiece !== 'P' && ts.P !== undefined && countOf('P') < 8 && ts.P >= altScore - 0.025) {
          altPiece = 'P';
        }
        const newCode = (white ? altPiece : altPiece.toLowerCase()) as PieceCode;
        board[claim.r][claim.c] = newCode;
        cells[claim.r][claim.c].piece = newCode;
      }
    }
  }

  // --- Coherence pass: promotion budget --------------------------------------
  // A color can only own extra queens/rooks/bishops/knights through
  // promotion, and each promotion costs a pawn. With `pawns` pawns still on
  // the board, at most (8 - pawns) pieces may exceed the initial counts.
  // Queens are the usual victims (R/B crowns read as Q): demote the
  // weakest-margin surplus claims to their best alternative type.
  for (const white of [true, false]) {
    const countOf = (p: PieceType): number => {
      const c2 = (white ? p : p.toLowerCase()) as PieceCode;
      let n = 0;
      for (const row of board) for (const q of row) if (q === c2) n++;
      return n;
    };
    const initial: Record<PieceType, number> = { K: 1, Q: 1, R: 2, B: 2, N: 2, P: 8 };
    const budget = 8 - countOf('P');
    let surplus = 0;
    for (const t of ['Q', 'R', 'B', 'N'] as PieceType[]) surplus += Math.max(0, countOf(t) - initial[t]);
    if (surplus <= budget) continue;
    for (const type of ['Q', 'R', 'B', 'N'] as PieceType[]) {
      while (countOf(type) > initial[type] && surplus > budget) {
        const code = (white ? type : type.toLowerCase()) as PieceCode;
        let weakest: { r: number; c: number; alt: PieceType; margin: number } | null = null;
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            if (board[r][c] !== code) continue;
            const ts = cells[r][c].typeScores ?? {};
            let alt: PieceType | null = null;
            let altScore = -Infinity;
            for (const [p, sc] of Object.entries(ts)) {
              if (p === type || p === 'K' || sc === undefined) continue;
              if (countOf(p as PieceType) >= initial[p as PieceType]) continue;
              if (sc > altScore) { altScore = sc; alt = p as PieceType; }
            }
            if (!alt) continue;
            const margin = (ts[type] ?? 0) - altScore;
            if (!weakest || margin < weakest.margin) weakest = { r, c, alt, margin };
          }
        }
        if (!weakest) break;
        const newCode = (white ? weakest.alt : weakest.alt.toLowerCase()) as PieceCode;
        board[weakest.r][weakest.c] = newCode;
        cells[weakest.r][weakest.c].piece = newCode;
        surplus--;
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

/** King/queen crowns are the most confusable silhouettes. When a second
 *  recognizer (the CNN, even when it reports itself unreliable overall) has
 *  an opinion on a K/Q cell whose silhouette scores are nearly tied, adopt
 *  it. Only swaps within the same color and only between K and Q. */
export function reconcileKingQueen(rec: RecognitionResult, other: BoardMatrix, maxDeficit = 0.1): number {
  let changed = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const mine = rec.board[r][c];
      const theirs = other[r][c];
      if (!mine || !theirs) continue;
      const myType = mine.toUpperCase();
      const theirType = theirs.toUpperCase();
      if (myType === theirType) continue;
      if (!((myType === 'K' && theirType === 'Q') || (myType === 'Q' && theirType === 'K'))) continue;
      const ts = rec.cells[r][c].typeScores;
      if (!ts || ts.K === undefined || ts.Q === undefined) continue;
      if (Math.abs(ts.K - ts.Q) > maxDeficit) continue;
      const white = mine === mine.toUpperCase();
      const code = (white ? theirType : theirType.toLowerCase()) as PieceCode;
      rec.board[r][c] = code;
      rec.cells[r][c].piece = code;
      changed++;
    }
  }
  // Never leave a color with two kings: when the other recognizer elected a
  // king, demote any remaining king of that color to its best non-king type.
  for (const kingCode of ['K', 'k'] as PieceCode[]) {
    const kings: { r: number; c: number; elected: boolean }[] = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (rec.board[r][c] === kingCode) kings.push({ r, c, elected: other[r][c] === kingCode });
      }
    }
    if (kings.length < 2 || !kings.some((k) => k.elected)) continue;
    for (const k of kings) {
      if (k.elected) continue;
      const ts = rec.cells[k.r][k.c].typeScores ?? {};
      let alt: PieceType = 'Q';
      let altScore = -Infinity;
      for (const [p, sc] of Object.entries(ts)) {
        if (p !== 'K' && sc !== undefined && sc > altScore) { altScore = sc; alt = p as PieceType; }
      }
      const code = (kingCode === 'K' ? alt : alt.toLowerCase()) as PieceCode;
      rec.board[k.r][k.c] = code;
      rec.cells[k.r][k.c].piece = code;
      changed++;
    }
  }
  return changed;
}
