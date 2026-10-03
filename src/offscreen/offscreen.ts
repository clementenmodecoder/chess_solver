/** Offscreen document: hosts the Stockfish WASM engine in a Web Worker and
 *  speaks UCI with it. Engine output is parsed here and forwarded to the
 *  service worker as compact EngineUpdate messages. */

import type { BackgroundToOffscreen, EngineOptions, EngineUpdate, OffscreenToBackground, VisionResult } from '../messages';
import { parseBestMove, parseInfoLine, type UciInfoLine } from '../engine/uci';
import {
  CONFIDENCE_FLOOR,
  extractTiles,
  probsToPlacement,
  recognizeGray,
  rgbaToGray,
  snapCorners,
  type BoardCorners,
  type GrayImage,
  type RecognitionResult,
} from '@scoriiu/fenshot';
import * as ort from 'onnxruntime-web/wasm';

const ENGINE_URL = 'engine/stockfish-19-lite-single.js';

let worker: Worker | null = null;
let engineReady: Promise<void> | null = null;
let engineName = 'Stockfish';

interface ActiveSearch {
  requestId: number;
  tabId: number;
  sideToMove: 'w' | 'b';
  lines: Map<number, UciInfoLine>;
  lastSent: number;
  timer: ReturnType<typeof setTimeout> | null;
}
let active: ActiveSearch | null = null;
let currentMultiPv = 1;
let currentElo = 0;

function send(cmd: string): void {
  worker?.postMessage(cmd);
}

function postUpdate(done: boolean, bestMove?: string, error?: string): void {
  if (!active) return;
  const update: EngineUpdate = {
    requestId: active.requestId,
    tabId: active.tabId,
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

async function analyze(fen: string, options: EngineOptions, requestId: number, tabId: number): Promise<void> {
  await initEngine();
  // Abort any running search; its bestmove will arrive for the OLD requestId
  // and be dropped because we swap `active` first.
  send('stop');
  const sideToMove = fen.split(' ')[1] === 'b' ? 'b' : 'w';
  active = { requestId, tabId, sideToMove, lines: new Map(), lastSent: 0, timer: null };
  if (options.multiPv !== currentMultiPv) {
    currentMultiPv = options.multiPv;
    send(`setoption name MultiPV value ${options.multiPv}`);
  }
  if ((options.elo ?? 0) !== currentElo) {
    currentElo = options.elo ?? 0;
    if (currentElo > 0) {
      send('setoption name UCI_LimitStrength value true');
      send(`setoption name UCI_Elo value ${Math.max(1320, Math.min(3190, currentElo))}`);
    } else {
      send('setoption name UCI_LimitStrength value false');
    }
  }
  send(`position fen ${fen}`);
  const parts: string[] = [];
  if (options.depth > 0) parts.push(`depth ${options.depth}`);
  if (options.movetimeMs > 0) parts.push(`movetime ${options.movetimeMs}`);
  send(parts.length ? `go ${parts.join(' ')}` : 'go movetime 5000');
}

// --- CNN board recognition (fenshot + onnxruntime-web) -----------------------
// fenshot's tile classifier is used through its building blocks rather than
// its all-in-one recognizer: when the content script already localized the
// board, the crop IS the board and must be classified as such (fenshot's own
// gradient-peak locator can lock a quarter tile off on textured themes).
// Without a known board, fenshot's locator scans the whole viewport.

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = {
      mjs: chrome.runtime.getURL('vision/ort-wasm-simd-threaded.mjs'),
      wasm: chrome.runtime.getURL('vision/ort-wasm-simd-threaded.wasm'),
    };
    sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL('vision/chess-tiles-v2.onnx'), {
      executionProviders: ['wasm'],
    });
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

async function classifyTiles(gray: GrayImage, corners: BoardCorners): Promise<RecognitionResult> {
  const session = await getSession();
  const tiles = extractTiles(gray, corners);
  const out = await session.run({ tiles: new ort.Tensor('float32', tiles, [64, 1024]) });
  return probsToPlacement(out['probs'].data as Float32Array);
}

async function dataUrlToGray(dataUrl: string): Promise<GrayImage> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return rgbaToGray(data.data, data.width, data.height);
}

async function recognizeBoard(dataUrl: string, exactBoard: boolean): Promise<VisionResult> {
  try {
    const gray = await dataUrlToGray(dataUrl);
    if (exactBoard) {
      // The image is the board. Classify it as-is, and also let fenshot's
      // checkerboard snap propose a sub-tile realignment; keep the read the
      // classifier is more confident about (same arbitration fenshot uses).
      const whole: BoardCorners = { x0: 0, y0: 0, x1: gray.width, y1: gray.height };
      let best = await classifyTiles(gray, whole);
      let corners = whole;
      const snapped = snapCorners(gray, whole);
      const moved = Math.abs(snapped.x0) + Math.abs(snapped.y0) + Math.abs(snapped.x1 - gray.width) + Math.abs(snapped.y1 - gray.height);
      if (moved > 0.5 && moved < gray.width * 0.1) {
        const alt = await classifyTiles(gray, snapped);
        if (alt.meanConfidence > best.meanConfidence) {
          best = alt;
          corners = snapped;
        }
      }
      return {
        ok: true,
        placement: best.placement,
        minConfidence: best.minConfidence,
        meanConfidence: best.meanConfidence,
        reliable: best.minConfidence >= CONFIDENCE_FLOOR,
        corners,
      };
    }
    const result = await recognizeGray(gray, (c) => classifyTiles(gray, c));
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
      analyze(message.fen, message.options, message.requestId, message.tabId).catch((err) => {
        active = { requestId: message.requestId, tabId: message.tabId, sideToMove: 'w', lines: new Map(), lastSent: 0, timer: null };
        postUpdate(true, undefined, String(err?.message ?? err));
        active = null;
      });
    } else if (message.type === 'engine-stop') {
      send('stop');
    } else if (message.type === 'offscreen-vision-recognize') {
      recognizeBoard(message.dataUrl, message.exactBoard === true).then(sendResponse);
      return true;
    }
  },
);

// Warm the model as soon as the offscreen document exists: the first scan is
// usually requested within a second of creation.
getSession().catch(() => undefined);
