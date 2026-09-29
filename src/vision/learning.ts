/** Per-site adaptive template learning.
 *
 *  Generic multi-set silhouette templates give a solid first read on any
 *  theme; once a scan validates with good confidence, the actual rendered
 *  silhouettes are harvested per piece type and reused as first-class
 *  templates. Subsequent scans on that site/theme then match nearly
 *  perfectly, whatever the piece style (including proprietary sets the
 *  extension cannot ship).
 */

import type { PieceType, RecognitionResult } from './types';
import type { PieceTemplate } from './templates';
import { silhouetteSimilarity, TEMPLATE_SIZE } from './silhouette';

/** Serializable store: a few learned silhouette variants per piece type. */
export interface LearnedEntry {
  /** Base64 of Uint8 TEMPLATE_SIZE^2 grid. */
  grid: string;
  relHeight: number;
  relWidth: number;
  /** How many harvested samples merged into this variant. */
  n: number;
}
export type LearnedStore = Partial<Record<PieceType, LearnedEntry[]>>;

const MAX_VARIANTS_PER_TYPE = 3;
const MERGE_SIMILARITY = 0.9;
const HARVEST_MIN_SCORE = 0.5;
const HARVEST_MIN_MARGIN = 0.04;
export const HARVEST_MIN_CONFIDENCE = 0.5;

function gridToBase64(grid: Float32Array): string {
  const bytes = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, grid[i])) * 255);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToGrid(b64: string): Float32Array {
  const bin = atob(b64);
  const grid = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) grid[i] = bin.charCodeAt(i) / 255;
  return grid;
}

export function learnedToTemplates(store: LearnedStore): PieceTemplate[] {
  const out: PieceTemplate[] = [];
  for (const [piece, entries] of Object.entries(store)) {
    for (const e of entries ?? []) {
      if (typeof e.grid !== 'string' || e.grid.length < 100) continue;
      const grid = base64ToGrid(e.grid);
      if (grid.length !== TEMPLATE_SIZE * TEMPLATE_SIZE) continue;
      out.push({
        set: 'learned',
        piece: piece as PieceType,
        color: 'w',
        grid,
        relHeight: e.relHeight,
        relWidth: e.relWidth,
      });
    }
  }
  return out;
}

/** Harvest confident cells of a validated recognition into the store.
 *  Returns true when the store changed. */
export function harvestIntoStore(store: LearnedStore, rec: RecognitionResult): boolean {
  if (rec.confidence < HARVEST_MIN_CONFIDENCE) return false;
  let changed = false;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = rec.cells[r][c];
      const sil = cell.silhouette;
      if (!cell.piece || !sil) continue;
      const type = cell.piece.toUpperCase() as PieceType;
      // Kings and queens are the intrinsically confusable crown pair, and a
      // validated position pins the kings down by constraint (exactly one
      // per color): accept them at low margin, or they would never be
      // learned on styles where the pair stays ambiguous.
      const minMargin = type === 'K' || type === 'Q' ? 0.005 : HARVEST_MIN_MARGIN;
      if (cell.score < HARVEST_MIN_SCORE || cell.margin < minMargin) continue;
      const entries = (store[type] ??= []);
      const grid = sil.grid;
      let merged = false;
      for (const e of entries) {
        const existing = base64ToGrid(e.grid);
        if (silhouetteSimilarity(grid, existing) >= MERGE_SIMILARITY) {
          // Running average, weighted by sample count (capped so new data
          // keeps some influence).
          const w = Math.min(e.n, 20);
          for (let i = 0; i < existing.length; i++) {
            existing[i] = (existing[i] * w + grid[i]) / (w + 1);
          }
          e.grid = gridToBase64(existing);
          e.relHeight = (e.relHeight * w + sil.relHeight) / (w + 1);
          e.relWidth = (e.relWidth * w + sil.relWidth) / (w + 1);
          e.n = Math.min(e.n + 1, 1000);
          merged = true;
          changed = true;
          break;
        }
      }
      if (!merged) {
        if (entries.length >= MAX_VARIANTS_PER_TYPE) {
          // Evict the least-supported variant.
          entries.sort((a, b) => a.n - b.n);
          entries.shift();
        }
        entries.push({
          grid: gridToBase64(grid),
          relHeight: sil.relHeight,
          relWidth: sil.relWidth,
          n: 1,
        });
        changed = true;
      }
    }
  }
  return changed;
}
