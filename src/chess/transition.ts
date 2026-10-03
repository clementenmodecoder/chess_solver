/** Side-to-move inference across successive scans.
 *
 *  A screenshot cannot show whose turn it is, but a TRANSITION can: when a
 *  previous position plus one legal move of side S equals the new position,
 *  the new side to move is the opposite of S. This lets watch mode track a
 *  replayed/analyzed game with the correct side to move on every move.
 *
 *  Two plies are also tried (previous position + a move + a reply): a fast
 *  reply, or a scan taken mid-animation that was later superseded, otherwise
 *  leaves a gap the one-move search cannot bridge.
 */

import { Chess } from 'chess.js';

function placementOf(fenOrPlacement: string): string {
  return fenOrPlacement.split(' ')[0];
}

/** Given the previous full FEN and the new placement field (ranks 8..1),
 *  return the side to move in the new position when it can be deduced from
 *  one legal move (or two consecutive legal plies), else null. */
export function inferSideAfterTransition(prevFen: string, newPlacement: string, maxPlies = 2): 'w' | 'b' | null {
  let prev: Chess;
  try {
    prev = new Chess(prevFen);
  } catch {
    return null;
  }
  const target = placementOf(newPlacement);
  if (placementOf(prev.fen()) === target) return null;
  const movedSide = prev.turn();
  const firstMoves = prev.moves({ verbose: true });
  for (const move of firstMoves) {
    const probe = new Chess(prevFen);
    try {
      probe.move(move.san);
    } catch {
      continue;
    }
    if (placementOf(probe.fen()) === target) {
      return movedSide === 'w' ? 'b' : 'w';
    }
  }
  if (maxPlies < 2) return null;
  // Two plies: prune with a cheap material check first. After two plies the
  // mover's piece count is unchanged and the opponent's drops by at most one.
  const count = (placement: string, white: boolean): number => {
    let n = 0;
    for (const ch of placement) if (/[a-z]/i.test(ch) && (ch === ch.toUpperCase()) === white) n++;
    return n;
  };
  const prevPlacement = placementOf(prev.fen());
  const dW = count(prevPlacement, true) - count(target, true);
  const dB = count(prevPlacement, false) - count(target, false);
  if (dW < 0 || dB < 0 || dW > 1 || dB > 1) return null;
  for (const move of firstMoves) {
    const afterFirst = new Chess(prevFen);
    try {
      afterFirst.move(move.san);
    } catch {
      continue;
    }
    const base = afterFirst.fen();
    for (const reply of afterFirst.moves({ verbose: true })) {
      const probe = new Chess(base);
      try {
        probe.move(reply.san);
      } catch {
        continue;
      }
      if (placementOf(probe.fen()) === target) return movedSide;
    }
  }
  return null;
}

/** Try several previous positions and return the first side-to-move
 *  deduction that succeeds. One-ply explanations are preferred (newest
 *  position first); two-ply explanations are then tried OLDEST first: when
 *  both a recent and an older position explain the new one in two plies, the
 *  recent one is usually a transient read (a piece captured mid-animation)
 *  and the older one the real predecessor. */
export function inferSideFromHistory(history: string[], newPlacement: string): 'w' | 'b' | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const side = inferSideAfterTransition(history[i], newPlacement, 1);
    if (side) return side;
  }
  for (let i = 0; i < history.length; i++) {
    const side = inferSideAfterTransition(history[i], newPlacement, 2);
    if (side) return side;
  }
  return null;
}
