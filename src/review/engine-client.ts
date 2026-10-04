/** In-page Stockfish client for the review page (an extension page: it may
 *  host the worker directly). Serialized: one search at a time, each `go`
 *  waits for its `bestmove`, which the single-threaded WASM build requires. */

import { parseBestMove, parseInfoLine, type UciInfoLine } from '../engine/uci';
import type { EngineLine } from './analyze';

export class ReviewEngine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private multiPv = 1;
  name = 'Stockfish';

  private init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const w = new Worker('engine/stockfish-19-lite-single.js');
      this.worker = w;
      const timeout = setTimeout(() => reject(new Error('engine init timeout')), 30000);
      w.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error(e.message));
      };
      w.onmessage = (e) => {
        const line = String(e.data);
        if (line.startsWith('id name')) this.name = line.slice(8).trim();
        else if (line === 'uciok') {
          w.postMessage('setoption name Hash value 64');
          w.postMessage('isready');
        } else if (line === 'readyok') {
          clearTimeout(timeout);
          resolve();
        }
      };
      w.postMessage('uci');
    });
    return this.ready;
  }

  /** Evaluate a position; resolves with lines sorted by multipv, scores
   *  from White's point of view. */
  evaluate(fen: string, opts: { depth: number; movetimeMs: number; multiPv: number }): Promise<EngineLine[]> {
    const run = async (): Promise<EngineLine[]> => {
      await this.init();
      const w = this.worker!;
      const side = fen.split(' ')[1] === 'b' ? 'b' : 'w';
      if (opts.multiPv !== this.multiPv) {
        this.multiPv = opts.multiPv;
        w.postMessage(`setoption name MultiPV value ${opts.multiPv}`);
      }
      const lines = new Map<number, UciInfoLine>();
      return new Promise<EngineLine[]>((resolve) => {
        w.onmessage = (e) => {
          const line = String(e.data);
          const info = parseInfoLine(line, side);
          if (info) {
            lines.set(info.multipv, info);
            return;
          }
          if (parseBestMove(line)) {
            const out = [...lines.values()]
              .sort((a, b) => a.multipv - b.multipv)
              .map((l) => ({ pv: l.pv, score: l.score, depth: l.depth }));
            resolve(out);
          }
        };
        w.postMessage(`position fen ${fen}`);
        w.postMessage(`go depth ${opts.depth} movetime ${opts.movetimeMs}`);
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
