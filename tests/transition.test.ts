import { describe, expect, it } from 'vitest';
import { inferSideAfterTransition } from '../src/chess/transition';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('inferSideAfterTransition', () => {
  it('deduces black to move after a white move', () => {
    // 1.e4 played on the page.
    expect(
      inferSideAfterTransition(START, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'),
    ).toBe('b');
  });

  it('deduces white to move after a black reply', () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(
      inferSideAfterTransition(afterE4, 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR'),
    ).toBe('w');
  });

  it('handles captures and castling', () => {
    const beforeCastle = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 1';
    expect(
      inferSideAfterTransition(beforeCastle, 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1'),
    ).toBe('b');
  });

  it('returns null when the new position is not one legal move away', () => {
    // Two moves at once (1.e4 c5 from start).
    expect(
      inferSideAfterTransition(START, 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR'),
    ).toBeNull();
    // Unrelated position.
    expect(inferSideAfterTransition(START, '8/8/4k3/8/8/3K4/4P3/8')).toBeNull();
  });

  it('returns null on unparseable input', () => {
    expect(inferSideAfterTransition('not a fen', '8/8/8/8/8/8/8/8')).toBeNull();
  });
});
