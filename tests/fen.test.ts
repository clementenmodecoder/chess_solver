import { describe, expect, it } from 'vitest';
import {
  buildFen,
  decideOrientation,
  inferCastling,
  orientMatrix,
  placementFromMatrix,
  placementToMatrix,
  validatePosition,
} from '../src/chess/fen';
import { Chess } from 'chess.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

describe('placement round-trip', () => {
  it('parses and serializes the initial position', () => {
    expect(placementFromMatrix(placementToMatrix(START))).toBe(START);
  });

  it('round-trips arbitrary positions', () => {
    const placements = [
      'r1bq1rk1/pp2ppbp/2np1np1/8/2PNP3/2N1B3/PP2BPPP/R2Q1RK1',
      '8/5pk1/6p1/8/3K4/8/5PP1/8',
      '8/8/4k3/8/8/3K4/4P3/8',
    ];
    for (const p of placements) {
      expect(placementFromMatrix(placementToMatrix(p))).toBe(p);
    }
  });
});

describe('orientation detection', () => {
  it('detects white at bottom for the initial position', () => {
    const m = placementToMatrix(START);
    const o = decideOrientation(m);
    expect(o.whiteAtBottom).toBe(true);
    expect(o.confidence).toBeGreaterThan(0.5);
  });

  it('detects black at bottom for the flipped initial position', () => {
    const screen = orientMatrix(placementToMatrix(START), false); // flip to screen coords
    const o = decideOrientation(screen);
    expect(o.whiteAtBottom).toBe(false);
  });

  it('flipping back restores white perspective', () => {
    const white = placementToMatrix(START);
    const screenFlipped = orientMatrix(white, false);
    expect(placementFromMatrix(orientMatrix(screenFlipped, false))).toBe(START);
  });

  it('handles sparse endgames', () => {
    const m = placementToMatrix('8/8/4k3/8/8/3K4/4P3/8');
    expect(decideOrientation(m).whiteAtBottom).toBe(true);
  });
});

describe('castling inference', () => {
  it('grants all rights in the initial position', () => {
    expect(inferCastling(placementToMatrix(START))).toBe('KQkq');
  });

  it('grants nothing when kings moved', () => {
    expect(inferCastling(placementToMatrix('rnbq1bnr/ppppkppp/8/4p3/4P3/8/PPPPKPPP/RNBQ1BNR'))).toBe('-');
  });

  it('partial rights', () => {
    expect(inferCastling(placementToMatrix('rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R'))).toBe('KQkq');
    expect(inferCastling(placementToMatrix('1nbqkbn1/rpppppp1/p6r/8/8/P6R/1PPPPPPP/RNBQKBN1'))).toBe('Q');
    expect(inferCastling(placementToMatrix('rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1'))).toBe('kq');
  });
});

describe('buildFen', () => {
  it('produces a chess.js-parseable FEN', () => {
    const fen = buildFen(placementToMatrix(START), 'w');
    expect(fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(() => new Chess(fen)).not.toThrow();
  });

  it('handles black to move', () => {
    const fen = buildFen(placementToMatrix('8/5pk1/6p1/8/3K4/8/5PP1/8'), 'b');
    expect(() => new Chess(fen)).not.toThrow();
    expect(fen).toContain(' b - - 0 1');
  });
});

describe('validatePosition', () => {
  it('accepts a normal position', () => {
    const v = validatePosition(placementToMatrix(START));
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('rejects missing kings', () => {
    const v = validatePosition(placementToMatrix('8/8/8/8/8/8/8/8'));
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/king/i);
  });

  it('rejects two white kings', () => {
    const v = validatePosition(placementToMatrix('4k3/8/8/8/8/8/8/2K1K3'));
    expect(v.ok).toBe(false);
  });

  it('rejects pawns on back ranks', () => {
    const v = validatePosition(placementToMatrix('P3k3/8/8/8/8/8/8/4K3'));
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/rank 8/i);
  });

  it('rejects adjacent kings', () => {
    const v = validatePosition(placementToMatrix('8/8/3kK3/8/8/8/8/8'));
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/adjacent/i);
  });

  it('warns on unusual material', () => {
    const v = validatePosition(placementToMatrix('QQQ1k3/8/8/8/8/8/8/4K3'));
    expect(v.ok).toBe(true);
    expect(v.warnings.length).toBeGreaterThan(0);
  });
});
