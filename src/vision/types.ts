/** Shared vision types. Everything operates on raw RGBA buffers so the same
 *  code runs in the browser (from a canvas) and in Node tests (from PNG). */

export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** FEN-style piece letters. Uppercase = white. */
export type PieceCode =
  | 'K' | 'Q' | 'R' | 'B' | 'N' | 'P'
  | 'k' | 'q' | 'r' | 'b' | 'n' | 'p';

export type PieceType = 'K' | 'Q' | 'R' | 'B' | 'N' | 'P';

/** board[row][col], row 0 = top of the image, col 0 = left. */
export type BoardMatrix = (PieceCode | null)[][];

export interface CellClassification {
  piece: PieceCode | null;
  /** Silhouette match quality of the winning piece type (0..1), 1 for confident empties. */
  score: number;
  /** Margin between best piece type and runner-up type (0..1). */
  margin: number;
  /** Best score per piece type (for coherence fix-ups). */
  typeScores?: Partial<Record<PieceType, number>>;
}

export interface RecognitionResult {
  board: BoardMatrix;
  cells: CellClassification[][];
  /** Aggregate confidence 0..1. */
  confidence: number;
}

export interface DetectedBoard {
  rect: Rect;
  score: number;
}
