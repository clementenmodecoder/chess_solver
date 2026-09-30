/** Side-to-move inference across successive scans.
 *
 *  A screenshot cannot show whose turn it is, but a TRANSITION can: when the
 *  previous position plus one legal move of side S equals the new position,
 *  the new side to move is the opposite of S. This lets watch mode track a
 *  replayed/analyzed game with the correct side to move on every move.
 */

import { Chess } from 'chess.js';

/** Given the previous full FEN and the new placement field (ranks 8..1),
 *  return the side to move in the new position when it can be deduced from a
 *  single legal move, else null. */
export function inferSideAfterTransition(prevFen: string, newPlacement: string): 'w' | 'b' | null {
  let prev: Chess;
  try {
    prev = new Chess(prevFen);
  } catch {
    return null;
  }
  const target = newPlacement.split(' ')[0];
  const movedSide = prev.turn();
  for (const move of prev.moves({ verbose: true })) {
    const probe = new Chess(prevFen);
    try {
      probe.move(move.san);
    } catch {
      continue;
    }
    if (probe.fen().split(' ')[0] === target) {
      return movedSide === 'w' ? 'b' : 'w';
    }
  }
  return null;
}
