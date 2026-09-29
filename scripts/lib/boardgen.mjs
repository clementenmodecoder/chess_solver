/** Shared synthetic chessboard renderer (fixtures + color-model training). */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSvg } from './util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const THEMES = {
  brown: { light: [240, 217, 181], dark: [181, 136, 99] },
  green: { light: [238, 238, 210], dark: [118, 150, 86] },
  blue: { light: [222, 227, 230], dark: [140, 162, 173] },
  gray: { light: [216, 216, 216], dark: [124, 124, 124] },
  // Low-ish contrast wooden-like theme (flat).
  walnut: { light: [192, 166, 132], dark: [131, 100, 74] },
  // Textured wood with visible vertical grain (chess.com-like).
  wood: { light: [222, 184, 135], dark: [154, 110, 74], grain: 14 },
};

export const POSITIONS = {
  start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
  middlegame: 'r1bq1rk1/pp2ppbp/2np1np1/8/2PNP3/2N1B3/PP2BPPP/R2Q1RK1',
  endgame: '8/5pk1/6p1/8/3K4/8/5PP1/8',
  promotion: '3q1q2/2P3P1/8/4k3/8/3K4/5p2/1Q6',
  sparse: '8/8/4k3/8/8/3K4/4P3/8',
  tactics: '2r3k1/p4ppp/1p2p3/3nP3/2rP4/2P1R3/P1B2PPP/R5K1',
};

export function placementToMatrixSimple(placement) {
  return placement.split('/').map((row) => {
    const out = [];
    for (const ch of row) {
      if (/[1-8]/.test(ch)) for (let i = 0; i < Number(ch); i++) out.push(null);
      else out.push(ch);
    }
    return out;
  });
}

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pieceCache = new Map();
export function pieceImage(set, code, size) {
  const key = `${set}/${code}/${size}`;
  if (!pieceCache.has(key)) {
    const color = code === code.toUpperCase() ? 'w' : 'b';
    const svgPath = resolve(root, `assets/pieces/${set}/${color}${code.toUpperCase()}.svg`);
    pieceCache.set(key, renderSvg(svgPath, size));
  }
  return pieceCache.get(key);
}

export function makeImage(width, height, fill = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1]; data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

/** Vertical wood-grain texture: smooth per-column streaks plus fine noise. */
export function fillGrainRect(img, x0, y0, w, h, color, amplitude, rand) {
  // Column offsets: sum of two sines with random phases + random walk.
  const phase1 = rand() * Math.PI * 2;
  const phase2 = rand() * Math.PI * 2;
  const f1 = 0.09 + rand() * 0.08;
  const f2 = 0.3 + rand() * 0.25;
  let walk = 0;
  for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
    walk += (rand() - 0.5) * 1.2;
    walk *= 0.92;
    const streak =
      Math.sin(x * f1 + phase1) * 0.6 + Math.sin(x * f2 + phase2) * 0.4 + walk * 0.3;
    for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
      const d = streak * amplitude + (rand() - 0.5) * amplitude * 0.5;
      const i = (y * img.width + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, color[0] + d));
      img.data[i + 1] = Math.max(0, Math.min(255, color[1] + d * 0.9));
      img.data[i + 2] = Math.max(0, Math.min(255, color[2] + d * 0.75));
    }
  }
}

/** 3x5 bitmap glyphs for board coordinates. */
const GLYPHS = {
  1: ['010', '110', '010', '010', '111'],
  2: ['110', '001', '010', '100', '111'],
  3: ['110', '001', '010', '001', '110'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '110', '001', '110'],
  6: ['011', '100', '110', '101', '010'],
  7: ['111', '001', '010', '010', '010'],
  8: ['010', '101', '010', '101', '010'],
  a: ['000', '011', '101', '101', '011'],
  b: ['100', '110', '101', '101', '110'],
  c: ['000', '011', '100', '100', '011'],
  d: ['001', '011', '101', '101', '011'],
  e: ['010', '101', '111', '100', '011'],
  f: ['011', '010', '111', '010', '010'],
  g: ['011', '101', '011', '001', '110'],
  h: ['100', '110', '101', '101', '101'],
};

export function drawGlyph(img, ch, x0, y0, scale, color) {
  const rows = GLYPHS[ch];
  if (!rows) return;
  for (let gy = 0; gy < rows.length; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      if (rows[gy][gx] === '1') {
        fillRect(img, x0 + gx * scale, y0 + gy * scale, scale, scale, color);
      }
    }
  }
}

export function fillRect(img, x0, y0, w, h, color, alpha = 1) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = img.data[i] * (1 - alpha) + color[0] * alpha;
      img.data[i + 1] = img.data[i + 1] * (1 - alpha) + color[1] * alpha;
      img.data[i + 2] = img.data[i + 2] * (1 - alpha) + color[2] * alpha;
    }
  }
}

export function blit(img, sprite, dx, dy) {
  for (let y = 0; y < sprite.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= img.height) continue;
    for (let x = 0; x < sprite.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= img.width) continue;
      const si = (y * sprite.width + x) * 4;
      const a = sprite.data[si + 3] / 255;
      if (a === 0) continue;
      const ti = (ty * img.width + tx) * 4;
      img.data[ti] = img.data[ti] * (1 - a) + sprite.data[si] * a;
      img.data[ti + 1] = img.data[ti + 1] * (1 - a) + sprite.data[si + 1] * a;
      img.data[ti + 2] = img.data[ti + 2] * (1 - a) + sprite.data[si + 2] * a;
    }
  }
}

/**
 * Render a board image.
 * cfg: { placement, set, theme, boardSize, whiteAtBottom, margin?, highlight?,
 *        coords?, clutterSeed? }
 * Returns { img, boardRect, screenMatrix }.
 */
export function renderBoard(cfg) {
  const { light, dark, grain } = THEMES[cfg.theme];
  const bs = cfg.boardSize;
  const cell = bs / 8;
  const margin = cfg.margin ?? 0;
  const W = bs + margin * 2;
  const H = bs + margin * 2;
  const img = makeImage(W, H, [246, 246, 244]);
  const rand = mulberry32(cfg.clutterSeed ?? 7);

  if (margin > 0) {
    // Page-like clutter: text-ish bars and colored blocks around the board.
    for (let i = 0; i < 60; i++) {
      const w = 20 + rand() * 180;
      const h = 4 + rand() * 14;
      const x = Math.floor(rand() * (W - w));
      const y = Math.floor(rand() * (H - h));
      if (x + w > margin - 4 && x < margin + bs + 4 && y + h > margin - 4 && y < margin + bs + 4) continue;
      const g = 120 + Math.floor(rand() * 120);
      fillRect(img, Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h), [g, g, g + 10]);
    }
  }

  const matrixWhite = placementToMatrixSimple(cfg.placement);
  const screenMatrix = cfg.whiteAtBottom
    ? matrixWhite
    : [...matrixWhite].reverse().map((r) => [...r].reverse());

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const x0 = Math.round(margin + c * cell);
      const y0 = Math.round(margin + r * cell);
      const x1 = Math.round(margin + (c + 1) * cell);
      const y1 = Math.round(margin + (r + 1) * cell);
      const color = (r + c) % 2 === 0 ? light : dark;
      if (grain) {
        // Browsers render board textures minified with smoothing, so the
        // apparent grain amplitude shrinks with cell size.
        const amp = grain * Math.min(1, cell / 90);
        fillGrainRect(img, x0, y0, x1 - x0, y1 - y0, color, amp, rand);
      } else {
        fillRect(img, x0, y0, x1 - x0, y1 - y0, color);
      }
    }
  }

  if (cfg.highlight) {
    for (const [r, c] of cfg.highlight) {
      const x0 = Math.round(margin + c * cell);
      const y0 = Math.round(margin + r * cell);
      fillRect(img, x0, y0, Math.round(cell), Math.round(cell), [255, 255, 51], 0.5);
    }
  }

  if (cfg.coords) {
    // Chess.com-style in-square coordinates: file letters bottom-right of the
    // bottom row, rank digits top-left of the left column.
    const scale = Math.max(1, Math.round(cell * 0.035));
    const files = 'abcdefgh';
    for (let c = 0; c < 8; c++) {
      const ch = cfg.whiteAtBottom ? files[c] : files[7 - c];
      drawGlyph(
        img,
        ch,
        Math.round(margin + (c + 1) * cell - 4.5 * scale),
        Math.round(margin + 8 * cell - 7 * scale),
        scale,
        (7 + c) % 2 === 0 ? dark : light,
      );
    }
    for (let r = 0; r < 8; r++) {
      const digit = String(cfg.whiteAtBottom ? 8 - r : r + 1);
      drawGlyph(
        img,
        digit,
        Math.round(margin + cell * 0.06),
        Math.round(margin + r * cell + cell * 0.06),
        scale,
        r % 2 === 0 ? dark : light,
      );
    }
  }

  const spriteSize = Math.round(cell);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const code = screenMatrix[r][c];
      if (!code) continue;
      const sprite = pieceImage(cfg.set, code, spriteSize);
      const dx = Math.round(margin + c * cell + (cell - sprite.width) / 2);
      const dy = Math.round(margin + r * cell + (cell - sprite.height) / 2);
      blit(img, sprite, dx, dy);
    }
  }

  return { img, boardRect: { x: margin, y: margin, w: bs, h: bs }, screenMatrix };
}
