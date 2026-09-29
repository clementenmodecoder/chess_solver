/** Board matrix -> FEN, orientation detection and position sanity checks. */

import type { BoardMatrix, PieceCode } from '../vision/types';

export interface OrientationResult {
  whiteAtBottom: boolean;
  confidence: number; // 0..1
}

/** Decide which side is at the bottom of the screen.
 *  Primary signal: average row of white vs black pieces (in most positions the
 *  armies stay on their own half). Pawn back-rank impossibilities are used as
 *  a hard override signal since pawns can never sit on their own back rank. */
export function decideOrientation(m: BoardMatrix): OrientationResult {
  let wSum = 0, wN = 0, bSum = 0, bN = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = m[r][c];
      if (!p) continue;
      if (p === p.toUpperCase()) { wSum += r; wN++; }
      else { bSum += r; bN++; }
    }
  }
  const whitePawnsTopRow = countPawnsOnRow(m, 0, 'P');
  const whitePawnsBottomRow = countPawnsOnRow(m, 7, 'P');
  const blackPawnsTopRow = countPawnsOnRow(m, 0, 'p');
  const blackPawnsBottomRow = countPawnsOnRow(m, 7, 'p');

  // whiteAtBottom implies: no white pawn may be on screen row 7 (rank 1) and
  // no black pawn on screen row 0 (rank 8). Wait - pawns can never be on rank
  // 1 or 8 at all, so *any* pawn on an extreme row is a recognition artifact;
  // still, "white pawn on top row" is consistent with white at bottom
  // (promotion square mis-read) - we only use asymmetries as soft hints.
  let pawnVote = 0;
  pawnVote += whitePawnsBottomRow > 0 ? -whitePawnsBottomRow : 0; // white pawns on bottom row => white NOT at bottom
  pawnVote += blackPawnsTopRow > 0 ? -blackPawnsTopRow : 0;       // black pawns on top row => black NOT at top
  pawnVote += whitePawnsTopRow > 0 ? whitePawnsTopRow : 0;
  pawnVote += blackPawnsBottomRow > 0 ? blackPawnsBottomRow : 0;

  if (wN === 0 || bN === 0) {
    return { whiteAtBottom: true, confidence: 0.1 };
  }
  const meanDiff = wSum / wN - bSum / bN; // >0 => white lower on screen
  const score = meanDiff + pawnVote * 1.5;
  const whiteAtBottom = score >= 0;
  return { whiteAtBottom, confidence: Math.min(1, Math.abs(score) / 4) };
}

function countPawnsOnRow(m: BoardMatrix, row: number, code: PieceCode): number {
  let n = 0;
  for (let c = 0; c < 8; c++) if (m[row][c] === code) n++;
  return n;
}

/** Re-index a screen-oriented matrix into white-perspective (row 0 = rank 8). */
export function orientMatrix(m: BoardMatrix, whiteAtBottom: boolean): BoardMatrix {
  if (whiteAtBottom) return m.map((row) => [...row]);
  return [...m].reverse().map((row) => [...row].reverse());
}

/** Piece placement field of a FEN from a white-perspective matrix. */
export function placementFromMatrix(oriented: BoardMatrix): string {
  return oriented
    .map((row) => {
      let out = '';
      let empty = 0;
      for (const p of row) {
        if (p === null) empty++;
        else {
          if (empty) { out += empty; empty = 0; }
          out += p;
        }
      }
      if (empty) out += empty;
      return out;
    })
    .join('/');
}

/** Conservative castling-rights inference: grant a right only when both the
 *  king and the corresponding rook still sit on their initial squares. */
export function inferCastling(oriented: BoardMatrix): string {
  let rights = '';
  if (oriented[7][4] === 'K') {
    if (oriented[7][7] === 'R') rights += 'K';
    if (oriented[7][0] === 'R') rights += 'Q';
  }
  if (oriented[0][4] === 'k') {
    if (oriented[0][7] === 'r') rights += 'k';
    if (oriented[0][0] === 'r') rights += 'q';
  }
  return rights || '-';
}

export function buildFen(oriented: BoardMatrix, sideToMove: 'w' | 'b', castling?: string): string {
  const placement = placementFromMatrix(oriented);
  const rights = castling ?? inferCastling(oriented);
  return `${placement} ${sideToMove} ${rights} - 0 1`;
}

/** Parse a FEN placement field into a white-perspective matrix (row 0 = rank 8). */
export function placementToMatrix(placement: string): BoardMatrix {
  const rows = placement.split('/');
  if (rows.length !== 8) throw new Error(`bad placement: ${placement}`);
  return rows.map((row) => {
    const out: (PieceCode | null)[] = [];
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) out.push(null);
      } else {
        out.push(ch as PieceCode);
      }
    }
    if (out.length !== 8) throw new Error(`bad placement row: ${row}`);
    return out;
  });
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Sanity checks on a white-perspective matrix. */
export function validatePosition(oriented: BoardMatrix): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts = new Map<PieceCode, number>();
  let wk: [number, number] | null = null;
  let bk: [number, number] | null = null;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = oriented[r][c];
      if (!p) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
      if (p === 'K') wk = [r, c];
      if (p === 'k') bk = [r, c];
    }
  }

  const wkCount = counts.get('K') ?? 0;
  const bkCount = counts.get('k') ?? 0;
  if (wkCount !== 1) errors.push(wkCount === 0 ? 'No white king found' : 'Multiple white kings found');
  if (bkCount !== 1) errors.push(bkCount === 0 ? 'No black king found' : 'Multiple black kings found');
  if (wk && bk && Math.abs(wk[0] - bk[0]) <= 1 && Math.abs(wk[1] - bk[1]) <= 1) {
    errors.push('Kings are adjacent (illegal position)');
  }
  if ((counts.get('P') ?? 0) > 8) errors.push('More than 8 white pawns');
  if ((counts.get('p') ?? 0) > 8) errors.push('More than 8 black pawns');

  for (let c = 0; c < 8; c++) {
    if (oriented[0][c] === 'P' || oriented[0][c] === 'p') errors.push('Pawn on rank 8');
    if (oriented[7][c] === 'P' || oriented[7][c] === 'p') errors.push('Pawn on rank 1');
  }

  let white = 0, black = 0;
  for (const [p, n] of counts) {
    if (p === p.toUpperCase()) white += n;
    else black += n;
  }
  if (white > 16) errors.push('More than 16 white pieces');
  if (black > 16) errors.push('More than 16 black pieces');
  if ((counts.get('Q') ?? 0) > 2 || (counts.get('q') ?? 0) > 2) warnings.push('More than 2 queens of one color (unusual)');
  if ((counts.get('N') ?? 0) > 3 || (counts.get('n') ?? 0) > 3) warnings.push('More than 3 knights of one color (unusual)');
  if ((counts.get('B') ?? 0) > 3 || (counts.get('b') ?? 0) > 3) warnings.push('More than 3 bishops of one color (unusual)');

  return { ok: errors.length === 0, errors, warnings };
}
