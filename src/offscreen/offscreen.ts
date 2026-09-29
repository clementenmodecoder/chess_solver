/** Offscreen document: hosts the Stockfish WASM engine in a Web Worker and
 *  speaks UCI with it. Engine output is parsed here and forwarded to the
 *  service worker as compact EngineUpdate messages. */

import type { BackgroundToOffscreen, EngineOptions, EngineUpdate, OffscreenToBackground, VisionResult } from '../messages';
import { parseBestMove, parseInfoLine, type UciInfoLine } from '../engine/uci';
import { createRecognizer, type Recognizer } from '@scoriiu/fenshot';

const ENGINE_URL = 'engine/stockfish-19-lite-single.js';

let worker: Worker | null = null;
let engineReady: Promise<void> | null = null;
let engineName = 'Stockfish';

interface ActiveSearch {
  requestId: number;
  sideToMove: 'w' | 'b';
  lines: Map<number, UciInfoLine>;
  lastSent: number;
  timer: ReturnType<typeof setTimeout> | null;
}
let active: ActiveSearch | null = null;
let currentMultiPv = 1;

function send(cmd: string): void {
  worker?.postMessage(cmd);
}

function postUpdate(done: boolean, bestMove?: string, error?: string): void {
  if (!active) return;
  const update: EngineUpdate = {
    requestId: active.requestId,
    lines: [...active.lines.values()].sort((a, b) => a.multipv - b.multipv),
    bestMove,
    engineName,
    done,
    error,
  };
  chrome.runtime.sendMessage({ type: 'engine-update', update } satisfies OffscreenToBackground).catch(() => {});
  active.lastSent = Date.now();
}

function scheduleUpdate(): void {
  if (!active || active.timer) return;
  const elapsed = Date.now() - active.lastSent;
  const delay = Math.max(0, 200 - elapsed);
  active.timer = setTimeout(() => {
    if (active) {
      active.timer = null;
      postUpdate(false);
    }
  }, delay);
}

function initEngine(): Promise<void> {
  if (engineReady) return engineReady;
  engineReady = new Promise<void>((resolve, reject) => {
    try {
      worker = new Worker(ENGINE_URL);
    } catch (err) {
      reject(err);
      return;
    }
    const timeout = setTimeout(() => reject(new Error('Engine failed to initialize (timeout)')), 30000);
    worker.onerror = (e) => {
      clearTimeout(timeout);
      reject(new Error(`Engine worker error: ${e.message}`));
    };
    worker.onmessage = (e: MessageEvent) => {
      const line = String(e.data);
      if (line.startsWith('id name')) {
        engineName = line.slice('id name '.length).trim();
      } else if (line === 'uciok') {
        clearTimeout(timeout);
        send('setoption name Hash value 32');
        send('isready');
      } else if (line === 'readyok') {
        resolve();
        // Switch to the runtime message handler.
        worker!.onmessage = onEngineLine;
      }
    };
    send('uci');
  });
  return engineReady;
}

function onEngineLine(e: MessageEvent): void {
  const line = String(e.data);
  if (!active) return;
  const info = parseInfoLine(line, active.sideToMove);
  if (info) {
    active.lines.set(info.multipv, info);
    scheduleUpdate();
    return;
  }
  const best = parseBestMove(line);
  if (best) {
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    postUpdate(true, best.move);
    active = null;
  }
}

async function analyze(fen: string, options: EngineOptions, requestId: number): Promise<void> {
  await initEngine();
  // Abort any running search; its bestmove will arrive for the OLD requestId
  // and be dropped because we swap `active` first.
  send('stop');
  const sideToMove = fen.split(' ')[1] === 'b' ? 'b' : 'w';
  active = { requestId, sideToMove, lines: new Map(), lastSent: 0, timer: null };
  if (options.multiPv !== currentMultiPv) {
    currentMultiPv = options.multiPv;
    send(`setoption name MultiPV value ${options.multiPv}`);
  }
  send(`position fen ${fen}`);
  const parts: string[] = [];
  if (options.depth > 0) parts.push(`depth ${options.depth}`);
  if (options.movetimeMs > 0) parts.push(`movetime ${options.movetimeMs}`);
  send(parts.length ? `go ${parts.join(' ')}` : 'go movetime 5000');
}

// --- CNN board recognition (fenshot + onnxruntime-web) -----------------------

let recognizer: Recognizer | null = null;

function getRecognizer(): Recognizer {
  if (!recognizer) {
    recognizer = createRecognizer({
      modelUrl: chrome.runtime.getURL('vision/chess-tiles-v2.onnx'),
      wasmPaths: {
        mjs: chrome.runtime.getURL('vision/ort-wasm-simd-threaded.mjs'),
        wasm: chrome.runtime.getURL('vision/ort-wasm-simd-threaded.wasm'),
      },
    });
    recognizer.warmUp();
  }
  return recognizer;
}

async function recognizeBoard(dataUrl: string): Promise<VisionResult> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const result = await getRecognizer().recognize(blob);
    if (!result) return { ok: true, reliable: false };
    return {
      ok: true,
      placement: result.placement,
      minConfidence: result.minConfidence,
      meanConfidence: result.meanConfidence,
      reliable: result.reliable,
      corners: result.corners,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

chrome.runtime.onMessage.addListener(
  (message: BackgroundToOffscreen, _sender, sendResponse: (r: VisionResult) => void) => {
    if (message.type === 'engine-analyze') {
      analyze(message.fen, message.options, message.requestId).catch((err) => {
        active = { requestId: message.requestId, sideToMove: 'w', lines: new Map(), lastSent: 0, timer: null };
        postUpdate(true, undefined, String(err?.message ?? err));
        active = null;
      });
    } else if (message.type === 'engine-stop') {
      send('stop');
    } else if (message.type === 'offscreen-vision-recognize') {
      recognizeBoard(message.dataUrl).then(sendResponse);
      return true;
    }
  },
);

// Warm the recognizer as soon as the offscreen document exists: the first
// scan is usually requested within a second of creation.
getRecognizer();
