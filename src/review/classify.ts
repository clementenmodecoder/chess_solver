/** Game-review scoring: win probability, per-move accuracy and the move
 *  classification scale (Brilliant … Blunder), computed from engine
 *  evaluations of the position before and after each move.
 *
 *  Conventions: every score is in centipawns from WHITE's point of view;
 *  mates are mapped to large finite values so the math stays monotonic. */

import type { UciScore } from '../engine/uci';

export type MoveClass =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'mistake'
  | 'miss'
  | 'blunder';

export const CLASS_LABEL: Record<MoveClass, string> = {
  brilliant: 'Brilliant',
  great: 'Great',
  best: 'Best',
  excellent: 'Excellent',
  good: 'Good',
  book: 'Book',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  miss: 'Miss',
  blunder: 'Blunder',
};

export const CLASS_SYMBOL: Record<MoveClass, string> = {
  brilliant: '!!',
  great: '!',
  best: '★',
  excellent: '✓',
  good: '✓',
  book: '📖',
  inaccuracy: '?!',
  mistake: '?',
  miss: '✕',
  blunder: '??',
};

const MATE_CP = 10000;

/** Centipawns (White POV) from a UCI score; mates become ±(MATE_CP - n). */
export function scoreToCp(score: UciScore): number {
  if (score.mate !== undefined) {
    if (score.mate === 0) return 0;
    return score.mate > 0 ? MATE_CP - score.mate : -MATE_CP - score.mate;
  }
  return score.cp ?? 0;
}

/** White's winning chances in percent for a centipawn score (lichess's
 *  logistic model, used by every mainstream accuracy metric). */
export function winPercent(cp: number): number {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/** Accuracy of a single move from the win-probability drop it caused, for
 *  the side that moved (0..100). */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  const drop = Math.max(0, winBefore - winAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

/** Aggregate per-player accuracy: mean of per-move accuracies, weighted
 *  slightly toward the volatile phases of the game (lichess-like). */
export function gameAccuracy(moveAccuracies: number[]): number {
  if (!moveAccuracies.length) return 0;
  const mean = moveAccuracies.reduce((a, b) => a + b, 0) / moveAccuracies.length;
  // Harmonic mean punishes single disasters more; blend both.
  const harmonic = moveAccuracies.length / moveAccuracies.reduce((a, b) => a + 1 / Math.max(1, b), 0);
  return Math.round(((mean + harmonic) / 2) * 10) / 10;
}

export interface MoveJudgementInput {
  /** Side that played the move. */
  mover: 'w' | 'b';
  /** Engine best line's eval of the position BEFORE the move (White POV). */
  evalBefore: number;
  /** Eval of the position AFTER the move, i.e. best reply's eval (White POV). */
  evalAfter: number;
  /** Second-best move eval before the move (White POV), when known. */
  evalSecondBefore?: number;
  /** The move played is the engine's first choice. */
  isEngineBest: boolean;
  /** The move is in the opening book. */
  isBook: boolean;
  /** The move gives up material that the engine still rates as best
   *  (sacrifice heuristic computed by the caller). */
  isSacrifice: boolean;
  /** Win% (mover POV) the mover had before the OPPONENT's previous move,
   *  to detect a missed opportunity handed over by the opponent. */
  opponentPrevDrop?: number;
}

export interface MoveJudgement {
  cls: MoveClass;
  /** Win-probability drop for the mover, in points (0 = perfect). */
  drop: number;
  accuracy: number;
  winBefore: number;
  winAfter: number;
}

/** Win% from the mover's perspective. */
function moverWin(cpWhite: number, mover: 'w' | 'b'): number {
  const w = winPercent(cpWhite);
  return mover === 'w' ? w : 100 - w;
}

export function judgeMove(input: MoveJudgementInput): MoveJudgement {
  const winBefore = moverWin(input.evalBefore, input.mover);
  const winAfter = moverWin(input.evalAfter, input.mover);
  const drop = Math.max(0, winBefore - winAfter);
  const accuracy = moveAccuracy(winBefore, winAfter);
  let cls: MoveClass;
  if (input.isBook) cls = 'book';
  else if (drop >= 20) cls = 'blunder';
  else if (drop >= 10) cls = 'mistake';
  else if (drop >= 5) cls = 'inaccuracy';
  else if (input.isEngineBest || drop <= 0.5) cls = 'best';
  else if (drop < 2) cls = 'excellent';
  else cls = 'good';

  // Miss: the opponent just handed over a big chance (their drop >= 10) and
  // the mover did not keep it (lost at least half of it).
  // A blunder stays a blunder: "miss" is reserved for moves that merely
  // fail to cash in (good/inaccuracy/mistake range).
  if (
    (cls === 'inaccuracy' || cls === 'mistake' || cls === 'good') &&
    input.opponentPrevDrop !== undefined &&
    input.opponentPrevDrop >= 10 &&
    drop >= input.opponentPrevDrop / 2
  ) {
    cls = 'miss';
  }

  if (cls === 'best') {
    // Great: the only move that holds — second best is clearly worse and
    // the position was not already decided.
    const second = input.evalSecondBefore;
    if (second !== undefined && winBefore > 10 && winBefore < 95) {
      const secondWin = moverWin(second, input.mover);
      if (winBefore - secondWin >= 10) cls = 'great';
    }
    // Brilliant: a sound sacrifice that is also the best move and does not
    // leave the mover lost.
    if (input.isSacrifice && winAfter >= 45) cls = 'brilliant';
  }
  return { cls, drop: Math.round(drop * 10) / 10, accuracy: Math.round(accuracy * 10) / 10, winBefore, winAfter };
}

/** Piece values for the sacrifice heuristic. */
export const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Material balance (White minus Black) of a FEN placement, in pawns. */
export function materialBalance(fen: string): number {
  let bal = 0;
  for (const ch of fen.split(' ')[0]) {
    const v = PIECE_VALUE[ch.toLowerCase()];
    if (v === undefined) continue;
    bal += ch === ch.toUpperCase() ? v : -v;
  }
  return bal;
}
