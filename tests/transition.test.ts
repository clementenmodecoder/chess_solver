import { describe, expect, it } from 'vitest';
import { inferSideAfterTransition, inferSideFromHistory } from '../src/chess/transition';

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
    // Two moves at once (1.e4 c5 from start), single-ply search only.
    expect(
      inferSideAfterTransition(START, 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR', 1),
    ).toBeNull();
    // Unrelated position.
    expect(inferSideAfterTransition(START, '8/8/4k3/8/8/3K4/4P3/8')).toBeNull();
  });

  it('returns null on unparseable input', () => {
    expect(inferSideAfterTransition('not a fen', '8/8/8/8/8/8/8/8')).toBeNull();
  });
});

describe('two-ply and history inference', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  it('bridges a move plus its reply (1.e4 c5 seen at once)', () => {
    expect(inferSideAfterTransition(start, 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR')).toBe('w');
  });
  it('bridges a capture reply', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2';
    // 2.dxe5 then ... nothing legal reaches an arbitrary placement
    expect(inferSideAfterTransition(fen, 'rnbqkbnr/pppp1ppp/8/4P3/8/8/PPP1PPPP/RNBQKBNR')).toBe('b');
  });
  it('returns null when more than two plies separate the positions', () => {
    expect(inferSideAfterTransition(start, 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R')).toBeNull();
  });
  it('history: a stale mid-animation read is bridged by an older position', () => {
    const midAnimation = 'rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR b KQkq - 0 1'; // read as e3
    expect(inferSideFromHistory([start, midAnimation], 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR')).toBe('w');
  });
});
