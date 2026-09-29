/** Minimal UCI "info" line parsing for Stockfish output. */

export interface UciScore {
  /** Centipawns from White's point of view. */
  cp?: number;
  /** Mate in N (positive = White mates), from White's point of view. */
  mate?: number;
}

export interface UciInfoLine {
  depth: number;
  seldepth?: number;
  multipv: number;
  score: UciScore;
  nodes?: number;
  nps?: number;
  timeMs?: number;
  /** Long-algebraic moves, e.g. ["e2e4", "e7e5"]. */
  pv: string[];
}

/** Parse a single `info ...` line. Returns null for lines without depth/pv
 *  (e.g. "info string ..." or currmove updates).
 *  `sideToMove` converts the engine's side-relative score to White's POV. */
export function parseInfoLine(line: string, sideToMove: 'w' | 'b'): UciInfoLine | null {
  if (!line.startsWith('info ')) return null;
  if (line.includes(' string ')) return null;
  const tokens = line.split(/\s+/);
  const info: Partial<UciInfoLine> = { multipv: 1, pv: [] };
  let hasScore = false;

  for (let i = 1; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth': info.depth = parseInt(tokens[++i], 10); break;
      case 'seldepth': info.seldepth = parseInt(tokens[++i], 10); break;
      case 'multipv': info.multipv = parseInt(tokens[++i], 10); break;
      case 'nodes': info.nodes = parseInt(tokens[++i], 10); break;
      case 'nps': info.nps = parseInt(tokens[++i], 10); break;
      case 'time': info.timeMs = parseInt(tokens[++i], 10); break;
      case 'score': {
        const kind = tokens[++i];
        const value = parseInt(tokens[++i], 10);
        const sign = sideToMove === 'w' ? 1 : -1;
        if (kind === 'cp') info.score = { cp: value * sign };
        else if (kind === 'mate') info.score = { mate: value * sign };
        hasScore = true;
        // Skip optional bound tokens.
        if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') i++;
        break;
      }
      case 'pv':
        info.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
      default:
        break;
    }
  }

  if (info.depth === undefined || !hasScore || !info.pv || info.pv.length === 0) return null;
  return info as UciInfoLine;
}

export function parseBestMove(line: string): { move: string; ponder?: string } | null {
  const m = line.match(/^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/);
  if (!m) return null;
  if (m[1] === '(none)') return { move: '' };
  return { move: m[1], ponder: m[2] };
}

/** Format a White-POV score for display: "+1.24", "-0.30", "M3", "M-4", "0.00". */
export function formatScore(score: UciScore): string {
  if (score.mate !== undefined) {
    return score.mate >= 0 ? `M${score.mate}` : `-M${-score.mate}`;
  }
  const pawns = (score.cp ?? 0) / 100;
  const s = pawns.toFixed(2);
  return pawns > 0 ? `+${s}` : s;
}

/** Map a White-POV score to a 0..1 white-share for the eval bar (sigmoid). */
export function scoreToBarFraction(score: UciScore): number {
  if (score.mate !== undefined) {
    return score.mate >= 0 ? 0.98 : 0.02;
  }
  const pawns = (score.cp ?? 0) / 100;
  // Lichess-like: 50% + 50% * (2/(1+exp(-0.368 * pawns)) - 1)
  const f = 0.5 + 0.5 * (2 / (1 + Math.exp(-0.368 * pawns)) - 1);
  return Math.max(0.02, Math.min(0.98, f));
}
