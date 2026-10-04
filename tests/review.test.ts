import { describe, expect, it } from 'vitest';
import { judgeMove, winPercent, moveAccuracy, gameAccuracy, scoreToCp, materialBalance } from '../src/review/classify';
import { reviewGame, type EngineLine } from '../src/review/analyze';
import { isBookPosition, bookSize } from '../src/review/book';
import { Chess } from 'chess.js';

describe('classification math', () => {
  it('win percent is symmetric and bounded', () => {
    expect(winPercent(0)).toBeCloseTo(50, 5);
    expect(winPercent(300) + winPercent(-300)).toBeCloseTo(100, 5);
    expect(winPercent(10000)).toBeLessThanOrEqual(100);
  });
  it('accuracy is 100 for no loss and drops with the swing', () => {
    expect(moveAccuracy(60, 60)).toBeCloseTo(100, 0);
    expect(moveAccuracy(60, 40)).toBeLessThan(50);
    expect(gameAccuracy([100, 100, 20])).toBeLessThan(80);
  });
  it('mate scores map to large monotonic cps', () => {
    expect(scoreToCp({ mate: 1 })).toBeGreaterThan(scoreToCp({ mate: 5 }));
    expect(scoreToCp({ mate: -2 })).toBeLessThan(-9000);
  });
  it('material balance', () => {
    expect(materialBalance('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(0);
    expect(materialBalance('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(9);
  });
  it('classifies by win-probability drop', () => {
    const base = { mover: 'w' as const, isEngineBest: false, isBook: false, isSacrifice: false };
    expect(judgeMove({ ...base, evalBefore: 50, evalAfter: 50, isEngineBest: true }).cls).toBe('best');
    expect(judgeMove({ ...base, evalBefore: 50, evalAfter: 30 }).cls).toBe('excellent');
    expect(judgeMove({ ...base, evalBefore: 50, evalAfter: -10 }).cls).toBe('inaccuracy');
    expect(judgeMove({ ...base, evalBefore: 50, evalAfter: -100 }).cls).toBe('mistake');
    expect(judgeMove({ ...base, evalBefore: 50, evalAfter: -500 }).cls).toBe('blunder');
    // Black mover: a drop for black means eval going UP.
    expect(judgeMove({ ...base, mover: 'b', evalBefore: -50, evalAfter: 500 }).cls).toBe('blunder');
  });
  it('great = only move, brilliant = sound sacrifice, miss = squandered chance', () => {
    const base = { mover: 'w' as const, isBook: false, isSacrifice: false };
    expect(judgeMove({ ...base, evalBefore: 100, evalAfter: 100, evalSecondBefore: -300, isEngineBest: true }).cls).toBe('great');
    expect(judgeMove({ ...base, evalBefore: 100, evalAfter: 100, isEngineBest: true, isSacrifice: true }).cls).toBe('brilliant');
    expect(judgeMove({ ...base, evalBefore: 400, evalAfter: 150, isEngineBest: false, opponentPrevDrop: 30 }).cls).toBe('miss');
    // A blunder is never softened into a miss.
    expect(judgeMove({ ...base, evalBefore: 400, evalAfter: -400, isEngineBest: false, opponentPrevDrop: 30 }).cls).toBe('blunder');
    expect(judgeMove({ ...base, evalBefore: 0, evalAfter: 0, isEngineBest: false, isBook: true }).cls).toBe('book');
  });
});

describe('opening book', () => {
  it('knows the mainstream lines and nothing random', () => {
    expect(bookSize()).toBeGreaterThan(500);
    const c = new Chess();
    for (const m of ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']) c.move(m);
    expect(isBookPosition(c.fen())).toBe(true);
    const d = new Chess();
    for (const m of ['e4', 'e5', 'Ke2']) d.move(m);
    expect(isBookPosition(d.fen())).toBe(false);
  });
});

describe('reviewGame with a fake engine', () => {
  // Fake engine: material-based eval; best move = the capture of the most
  // valuable piece, else the first legal move. Deterministic and cheap.
  const fake = async (fen: string): Promise<EngineLine[]> => {
    const c = new Chess(fen);
    const moves = c.moves({ verbose: true });
    if (!moves.length) return [{ pv: [], score: { cp: 0 }, depth: 1 }];
    const val: Record<string, number> = { p: 100, n: 300, b: 300, r: 500, q: 900, k: 0 };
    const scored = moves.map((m) => ({ m, gain: m.captured ? val[m.captured] : 0 }));
    scored.sort((a, b) => b.gain - a.gain);
    const sign = c.turn() === 'w' ? 1 : -1;
    const mat = materialBalance(fen) * 100;
    return scored.slice(0, 2).map((s) => ({
      pv: [s.m.from + s.m.to + (s.m.promotion ?? '')],
      score: { cp: mat + sign * s.gain },
      depth: 1,
    }));
  };

  it('produces a complete report for the user\'s bot game', async () => {
    const pgn = `[Event "Play vs Bot"]
[White "YourKnightMare69"]
[Black "Wendy-BOT"]
[Result "0-1"]
[ECOUrl "https://www.chess.com/openings/Queens-Gambit-Declined"]

1. d4 d5 2. c4 e6 3. Bh6 Nxh6 4. e3 Nd7 5. Nc3 Bb4 6. Nf3 dxc4 7. Bxc4 Bxc3+ 8.
bxc3 Nb6 9. Bd3 Qd7 10. O-O Na4 11. Ne5 Qe7 12. Qxa4+ c6 13. Nxc6 Qd7 14. Bb5 a6
15. Bxa6 bxc6 16. Bxc8 Rxc8 17. Rfb1 c5 18. Qd1 cxd4 19. cxd4 O-O 20. a4 Qc6 21.
a5 f6 22. Rb6 Qe4 23. a6 e5 24. Qb3+ Kh8 25. d5 Rfd8 26. a7 Nf5 27. Rb4 Qxd5 28.
Qxd5 Rxd5 29. h3 Rdd8 30. Rb8 Rxb8 31. axb8=Q Rxb8 32. Kh2 Nd6 33. Rh1 Nc4 34.
Kg1 Rb4 35. Rh2 Rb1# 0-1`;
    const progress: number[] = [];
    const r = await reviewGame(pgn, fake, (p) => progress.push(p.ply));
    expect(r.moves.length).toBe(70);
    expect(r.evalSeries.length).toBe(71);
    expect(progress[progress.length - 1]).toBe(71);
    expect(r.headers['White']).toBe('YourKnightMare69');
    // 3.Bh6?? hangs a bishop for nothing: a blunder for White.
    const bh6 = r.moves[4];
    expect(bh6.san).toBe('Bh6');
    expect(['blunder', 'mistake']).toContain(bh6.judgement.cls);
    expect(bh6.bestMoveSan).not.toBeNull();
    // 1.d4 d5 2.c4 e6 are book moves.
    expect(r.moves.slice(0, 4).every((m) => m.judgement.cls === 'book')).toBe(true);
    // Final position is mate: eval series ends at a mate score for Black.
    expect(r.evalSeries[70]).toBeLessThan(-9000);
    expect(r.accuracy.w).toBeGreaterThanOrEqual(0);
    expect(r.accuracy.b).toBeLessThanOrEqual(100);
    expect(r.keyMoments.length).toBeGreaterThan(0);
    const total = (Object.values(r.counts.w) as number[]).reduce((a, b) => a + b, 0) + (Object.values(r.counts.b) as number[]).reduce((a, b) => a + b, 0);
    expect(total).toBe(70);
  });
});
