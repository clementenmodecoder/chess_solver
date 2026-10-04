/** Game review orchestration: walk a PGN, evaluate every position with an
 *  injected engine (MultiPV 2), and judge each move. Pure of any DOM so it
 *  is unit-testable with a fake engine. */

import { Chess, type Move } from 'chess.js';
import type { UciScore } from '../engine/uci';
import {
  gameAccuracy,
  judgeMove,
  materialBalance,
  scoreToCp,
  type MoveClass,
  type MoveJudgement,
} from './classify';
import { isBookPosition } from './book';

export interface EngineLine {
  /** UCI moves of the principal variation. */
  pv: string[];
  score: UciScore;
  depth: number;
}

/** Evaluate a FEN; must return lines sorted by multipv (best first), scores
 *  from WHITE's point of view. */
export type Evaluator = (fen: string, plyIndex: number) => Promise<EngineLine[]>;

export interface ReviewedMove {
  ply: number; // 1-based
  moveNumber: number;
  mover: 'w' | 'b';
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** White-POV centipawns after the move. */
  evalAfterCp: number;
  evalAfterText: string;
  bestMoveSan: string | null;
  bestMoveUci: string | null;
  bestLineSan: string;
  judgement: MoveJudgement;
  /** Short human explanation ("Nf3 was best", "Missed a mate"…). */
  note: string;
}

export interface ReviewResult {
  headers: Record<string, string>;
  moves: ReviewedMove[];
  /** Eval (White POV cp) of the start position, then after each ply. */
  evalSeries: number[];
  accuracy: { w: number; b: number };
  counts: { w: Record<MoveClass, number>; b: Record<MoveClass, number> };
  keyMoments: ReviewedMove[];
  result: string;
}

export interface ReviewProgress {
  ply: number;
  total: number;
}

function emptyCounts(): Record<MoveClass, number> {
  return { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, miss: 0, blunder: 0 };
}

export function formatCp(cp: number): string {
  if (Math.abs(cp) >= 9000) {
    const n = 10000 - Math.abs(cp);
    if (n === 0) return cp > 0 ? '1-0 #' : '0-1 #';
    return cp > 0 ? `M${n}` : `-M${n}`;
  }
  const p = cp / 100;
  return (p > 0 ? '+' : '') + p.toFixed(2);
}

function uciOf(m: Move): string {
  return m.from + m.to + (m.promotion ?? '');
}

/** Convert a UCI line to SAN from a FEN, tolerating illegal tails. */
export function sanFromUci(fen: string, uci: string[], max = 6): string {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const u of uci.slice(0, max)) {
    try {
      const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? (u[4] as 'q' | 'r' | 'b' | 'n') : undefined });
      out.push(mv.san);
    } catch {
      break;
    }
  }
  return out.join(' ');
}

/** Sacrifice heuristic: the move leaves material en prise that the engine
 *  still rates as best. We compare material after the opponent's best
 *  capture reply with material before the move. */
function looksLikeSacrifice(fenBefore: string, move: Move, fenAfter: string, bestReplyUci: string | undefined, mover: 'w' | 'b'): boolean {
  const sign = mover === 'w' ? 1 : -1;
  const before = materialBalance(fenBefore) * sign;
  if (!bestReplyUci) return false;
  try {
    const c = new Chess(fenAfter);
    const reply = c.move({ from: bestReplyUci.slice(0, 2), to: bestReplyUci.slice(2, 4), promotion: bestReplyUci.length > 4 ? (bestReplyUci[4] as 'q') : undefined });
    if (!reply.captured) return false;
    const after = materialBalance(c.fen()) * sign;
    // Lost at least a minor piece's worth net, and the moved piece (or a
    // piece left hanging) is what got taken: a real investment, not a trade.
    return before - after >= 2 && move.piece !== 'p';
  } catch {
    return false;
  }
}

export async function reviewGame(
  pgn: string,
  evaluate: Evaluator,
  onProgress?: (p: ReviewProgress) => void,
): Promise<ReviewResult> {
  const game = new Chess();
  game.loadPgn(pgn);
  const headers = game.getHeaders();
  const history = game.history({ verbose: true });
  const start = new Chess();
  if (headers['FEN']) start.load(headers['FEN']);
  const fens: string[] = [start.fen()];
  const replay = new Chess(start.fen());
  for (const m of history) {
    replay.move(m.san);
    fens.push(replay.fen());
  }

  // Evaluate every position once (MultiPV 2).
  const evals: EngineLine[][] = [];
  for (let i = 0; i < fens.length; i++) {
    onProgress?.({ ply: i, total: fens.length });
    const c = new Chess(fens[i]);
    if (c.isGameOver()) {
      // Checkmate: the side to move is mated (White POV ±10000, shown as "#");
      // any other game end (stalemate, insufficient material…) is a draw.
      const cp = c.isCheckmate() ? (c.turn() === 'w' ? -10000 : 10000) : 0;
      evals.push([{ pv: [], score: { cp }, depth: 0 }]);
      continue;
    }
    evals.push(await evaluate(fens[i], i));
  }
  onProgress?.({ ply: fens.length, total: fens.length });

  const cpOf = (lines: EngineLine[]): number => (lines[0] ? scoreToCp(lines[0].score) : 0);
  const evalSeries = evals.map(cpOf);

  const moves: ReviewedMove[] = [];
  const counts = { w: emptyCounts(), b: emptyCounts() };
  const accs = { w: [] as number[], b: [] as number[] };
  let inBook = true;
  let prevDrop: Record<'w' | 'b', number | undefined> = { w: undefined, b: undefined };

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const mover = m.color as 'w' | 'b';
    const fenBefore = fens[i];
    const fenAfter = fens[i + 1];
    const linesBefore = evals[i];
    const best = linesBefore[0];
    const second = linesBefore[1];
    const uci = uciOf(m);
    const isEngineBest = !!best && best.pv[0] === uci;
    const evalBefore = cpOf(linesBefore);
    const evalAfter = evalSeries[i + 1];
    if (inBook && !isBookPosition(fenAfter)) inBook = false;
    const isBook = inBook;
    const bestReply = evals[i + 1]?.[0]?.pv?.[0];
    const isSacrifice = looksLikeSacrifice(fenBefore, m, fenAfter, bestReply, mover);
    const delivered = new Chess(fenAfter).isCheckmate();
    const judgement = judgeMove({
      mover,
      evalBefore,
      evalAfter,
      evalSecondBefore: second ? scoreToCp(second.score) : undefined,
      isEngineBest,
      isBook,
      isSacrifice,
      opponentPrevDrop: prevDrop[mover === 'w' ? 'b' : 'w'],
    });
    if (delivered) {
      judgement.cls = 'best';
      judgement.drop = 0;
      judgement.accuracy = 100;
    }
    prevDrop[mover] = judgement.drop;

    const bestMoveUci = best?.pv[0] ?? null;
    const bestMoveSan = bestMoveUci ? sanFromUci(fenBefore, [bestMoveUci], 1) || null : null;
    const bestLineSan = best ? sanFromUci(fenBefore, best.pv, 6) : '';
    let note = '';
    switch (judgement.cls) {
      case 'brilliant':
        note = 'A sound sacrifice — the engine agrees it is the best move.';
        break;
      case 'great':
        note = 'The only move that keeps the position; everything else was clearly worse.';
        break;
      case 'best':
        note = 'The engine\'s first choice.';
        break;
      case 'excellent':
        note = bestMoveSan ? `Nearly as good as ${bestMoveSan}.` : 'Nearly as good as the best move.';
        break;
      case 'good':
        note = bestMoveSan ? `Fine, but ${bestMoveSan} was more precise.` : 'A reasonable move.';
        break;
      case 'book':
        note = 'Opening theory.';
        break;
      case 'inaccuracy':
        note = bestMoveSan ? `${bestMoveSan} was better.` : 'A more precise move was available.';
        break;
      case 'mistake':
        note = bestMoveSan ? `${bestMoveSan} was much better (${formatCp(evalBefore)} → ${formatCp(evalAfter)}).` : 'A clear mistake.';
        break;
      case 'miss':
        note = bestMoveSan ? `Missed the opportunity ${bestMoveSan} after the opponent's error.` : 'Missed an opportunity.';
        break;
      case 'blunder':
        note = bestMoveSan
          ? `Blunder. ${bestMoveSan} was required (${formatCp(evalBefore)} → ${formatCp(evalAfter)}).`
          : 'Blunder.';
        break;
    }

    const reviewed: ReviewedMove = {
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      mover,
      san: m.san,
      uci,
      fenBefore,
      fenAfter,
      evalAfterCp: evalAfter,
      evalAfterText: formatCp(evalAfter),
      bestMoveSan,
      bestMoveUci,
      bestLineSan,
      judgement,
      note,
    };
    moves.push(reviewed);
    counts[mover][judgement.cls]++;
    if (judgement.cls !== 'book') accs[mover].push(judgement.accuracy);
  }

  const keyMoments = moves
    .filter((m) => m.judgement.cls === 'blunder' || m.judgement.cls === 'mistake' || m.judgement.cls === 'miss' || m.judgement.cls === 'brilliant' || m.judgement.cls === 'great')
    .sort((a, b) => b.judgement.drop - a.judgement.drop)
    .slice(0, 8)
    .sort((a, b) => a.ply - b.ply);

  return {
    headers,
    moves,
    evalSeries,
    accuracy: { w: gameAccuracy(accs.w), b: gameAccuracy(accs.b) },
    counts,
    keyMoments,
    result: headers['Result'] ?? '*',
  };
}
