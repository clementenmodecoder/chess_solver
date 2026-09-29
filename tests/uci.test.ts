import { describe, expect, it } from 'vitest';
import { formatScore, parseBestMove, parseInfoLine, scoreToBarFraction } from '../src/engine/uci';

describe('parseInfoLine', () => {
  const line =
    'info depth 18 seldepth 24 multipv 1 score cp 34 nodes 1234567 nps 850000 hashfull 120 tbhits 0 time 1452 pv e2e4 e7e5 g1f3 b8c6';

  it('parses a full info line (white to move)', () => {
    const info = parseInfoLine(line, 'w');
    expect(info).not.toBeNull();
    expect(info!.depth).toBe(18);
    expect(info!.multipv).toBe(1);
    expect(info!.score.cp).toBe(34);
    expect(info!.pv).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    expect(info!.nodes).toBe(1234567);
    expect(info!.timeMs).toBe(1452);
  });

  it('negates score when black to move', () => {
    const info = parseInfoLine(line, 'b');
    expect(info!.score.cp).toBe(-34);
  });

  it('parses mate scores', () => {
    const info = parseInfoLine('info depth 12 multipv 1 score mate 3 nodes 5000 pv d1h5 g8h6 h5f7', 'w');
    expect(info!.score.mate).toBe(3);
    const infoB = parseInfoLine('info depth 12 multipv 1 score mate 3 nodes 5000 pv d1h5', 'b');
    expect(infoB!.score.mate).toBe(-3);
  });

  it('handles bound annotations', () => {
    const info = parseInfoLine('info depth 10 multipv 1 score cp 55 lowerbound nodes 1 pv e2e4', 'w');
    expect(info!.score.cp).toBe(55);
    expect(info!.pv).toEqual(['e2e4']);
  });

  it('ignores string/currmove lines', () => {
    expect(parseInfoLine('info string NNUE evaluation using nn.nnue', 'w')).toBeNull();
    expect(parseInfoLine('info depth 15 currmove e2e4 currmovenumber 1', 'w')).toBeNull();
  });
});

describe('parseBestMove', () => {
  it('parses bestmove with ponder', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toEqual({ move: 'e2e4', ponder: 'e7e5' });
  });
  it('parses bestmove without ponder', () => {
    expect(parseBestMove('bestmove g1f3')).toEqual({ move: 'g1f3', ponder: undefined });
  });
  it('handles (none)', () => {
    expect(parseBestMove('bestmove (none)')).toEqual({ move: '' });
  });
  it('rejects other lines', () => {
    expect(parseBestMove('info depth 3')).toBeNull();
  });
});

describe('formatScore', () => {
  it('formats centipawns', () => {
    expect(formatScore({ cp: 124 })).toBe('+1.24');
    expect(formatScore({ cp: -170 })).toBe('-1.70');
    expect(formatScore({ cp: 0 })).toBe('0.00');
  });
  it('formats mates', () => {
    expect(formatScore({ mate: 3 })).toBe('M3');
    expect(formatScore({ mate: -4 })).toBe('-M4');
  });
});

describe('scoreToBarFraction', () => {
  it('is 0.5 at equality and monotonic', () => {
    expect(scoreToBarFraction({ cp: 0 })).toBeCloseTo(0.5, 5);
    expect(scoreToBarFraction({ cp: 100 })).toBeGreaterThan(0.5);
    expect(scoreToBarFraction({ cp: -100 })).toBeLessThan(0.5);
    expect(scoreToBarFraction({ cp: 500 })).toBeGreaterThan(scoreToBarFraction({ cp: 200 }));
  });
  it('clamps mates near the edges', () => {
    expect(scoreToBarFraction({ mate: 2 })).toBeGreaterThan(0.95);
    expect(scoreToBarFraction({ mate: -2 })).toBeLessThan(0.05);
  });
});
