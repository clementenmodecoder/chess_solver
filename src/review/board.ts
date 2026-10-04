/** Minimal SVG chessboard renderer for the review page: position from a
 *  FEN, optional last-move highlight, best-move arrow and a classification
 *  badge on the destination square. Pieces are the bundled cburnett SVGs. */

import { placementToMatrix } from '../chess/fen';

export interface BoardView {
  fen: string;
  whiteAtBottom: boolean;
  lastMove?: { from: string; to: string } | null;
  arrow?: { from: string; to: string; color: string } | null;
  badge?: { square: string; text: string; color: string } | null;
}

const LIGHT = '#ece0c8';
const DARK = '#9c7b58';

function sqToRC(sq: string, whiteAtBottom: boolean): { r: number; c: number } {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const r = whiteAtBottom ? 7 - rank : rank;
  const c = whiteAtBottom ? file : 7 - file;
  return { r, c };
}

export function renderBoard(container: HTMLElement, view: BoardView, pieceUrl: (code: string) => string): void {
  const S = 100; // logical square size
  const matrix = placementToMatrix(view.fen.split(' ')[0]);
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="board">`);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const light = (r + c) % 2 === 0;
      parts.push(`<rect x="${c * S}" y="${r * S}" width="${S}" height="${S}" fill="${light ? LIGHT : DARK}"/>`);
    }
  }
  if (view.lastMove) {
    for (const sq of [view.lastMove.from, view.lastMove.to]) {
      const { r, c } = sqToRC(sq, view.whiteAtBottom);
      parts.push(`<rect x="${c * S}" y="${r * S}" width="${S}" height="${S}" fill="rgba(255,210,60,.45)"/>`);
    }
  }
  // Coordinates
  for (let i = 0; i < 8; i++) {
    const file = String.fromCharCode(97 + (view.whiteAtBottom ? i : 7 - i));
    const rank = view.whiteAtBottom ? 8 - i : i + 1;
    parts.push(`<text x="${i * S + 4}" y="${7 * S + S - 5}" font-size="18" fill="${i % 2 === 0 ? DARK : LIGHT}" font-family="sans-serif">${file}</text>`);
    parts.push(`<text x="${7 * S + S - 16}" y="${i * S + 20}" font-size="18" fill="${i % 2 === 0 ? DARK : LIGHT}" font-family="sans-serif">${rank}</text>`);
  }
  // Pieces (white-perspective matrix row 0 = rank 8)
  for (let rr = 0; rr < 8; rr++) {
    for (let cc = 0; cc < 8; cc++) {
      const p = matrix[rr][cc];
      if (!p) continue;
      const r = view.whiteAtBottom ? rr : 7 - rr;
      const c = view.whiteAtBottom ? cc : 7 - cc;
      const code = (p === p.toUpperCase() ? 'w' : 'b') + p.toUpperCase();
      parts.push(`<image href="${pieceUrl(code)}" x="${c * S + 4}" y="${r * S + 4}" width="${S - 8}" height="${S - 8}"/>`);
    }
  }
  if (view.arrow) {
    const a = sqToRC(view.arrow.from, view.whiteAtBottom);
    const b = sqToRC(view.arrow.to, view.whiteAtBottom);
    const x1 = a.c * S + S / 2, y1 = a.r * S + S / 2;
    const x2 = b.c * S + S / 2, y2 = b.r * S + S / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const head = 30;
    const ex = x2 - ux * head, ey = y2 - uy * head;
    parts.push(`<line x1="${x1 + ux * 25}" y1="${y1 + uy * 25}" x2="${ex}" y2="${ey}" stroke="${view.arrow.color}" stroke-width="18" stroke-linecap="round" opacity=".85"/>`);
    const px = -uy, py = ux;
    parts.push(
      `<polygon points="${x2},${y2} ${ex + px * 22},${ey + py * 22} ${ex - px * 22},${ey - py * 22}" fill="${view.arrow.color}" opacity=".85"/>`,
    );
  }
  if (view.badge) {
    const { r, c } = sqToRC(view.badge.square, view.whiteAtBottom);
    const cx = c * S + S - 18, cy = r * S + 18;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="17" fill="${view.badge.color}" stroke="#fff" stroke-width="3"/>`);
    parts.push(
      `<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="18" font-weight="700" fill="#fff" font-family="sans-serif">${view.badge.text}</text>`,
    );
  }
  parts.push('</svg>');
  container.innerHTML = parts.join('');
}
