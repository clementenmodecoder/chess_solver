/** Content script: orchestrates capture -> board detection -> recognition ->
 *  FEN -> engine analysis, and drives the overlay UI. Injected on demand via
 *  the toolbar action (activeTab), never automatically. */

import { Chess } from 'chess.js';
import type { RGBAImage, Rect } from '../vision/types';
import { detectBoard, snapGrid } from '../vision/detect';
import { classifyBoard } from '../vision/classify';
import { loadTemplates } from '../vision/templates';
import { harvestIntoStore, learnedToTemplates, HARVEST_MIN_CONFIDENCE, type LearnedStore } from '../vision/learning';
import { crop } from '../vision/image';
import {
  buildFen,
  decideOrientation,
  orientMatrix,
  placementToMatrix,
  validatePosition,
} from '../chess/fen';
import { formatScore, scoreToBarFraction, type UciInfoLine } from '../engine/uci';
import type { BackgroundToContent, CaptureResponse, EngineUpdate, Settings, VisionResult } from '../messages';
import { DEFAULT_SETTINGS } from '../messages';
import { Overlay, type CssRect } from './overlay';
import { detectPlayContext } from './safety';

declare global {
  interface Window {
    __chessLensActive?: boolean;
    /** Debug/E2E hook: latest recognition + engine state. */
    __chessLensDebug?: {
      fen: string | null;
      status: string;
      depth: number;
      scoreText: string;
      bestMove: string;
      engineDone: boolean;
      whiteAtBottom: boolean;
      error: string | null;
      recognizer?: 'cnn' | 'classic';
      /** How many times the overlay was hidden for a capture (flicker probe). */
      hideCount?: number;
      scanCount?: number;
    };
  }
}

function updateDebug(partial: Partial<NonNullable<Window['__chessLensDebug']>>): void {
  if (!window.__chessLensDebug) {
    window.__chessLensDebug = {
      fen: null,
      status: 'boot',
      depth: 0,
      scoreText: '',
      bestMove: '',
      engineDone: false,
      whiteAtBottom: true,
      error: null,
    };
  }
  Object.assign(window.__chessLensDebug, partial);
  // Content scripts run in an isolated world; mirror the state into the
  // shared DOM so page-world tooling (and the E2E suite) can observe it.
  try {
    document.documentElement.dataset.chessLensDebug = JSON.stringify(window.__chessLensDebug);
  } catch {
    /* ignore */
  }
}

interface BoardSource {
  /** Live DOM element tracking (best: survives scroll/resize). */
  element: Element | null;
  /** Viewport rect (CSS px) at last successful detection. */
  cssRect: CssRect | null;
  /** Manual selection rect (CSS px, viewport). */
  manualRect: CssRect | null;
}

class ChessLens {
  private overlay: Overlay;
  private settings: Settings = DEFAULT_SETTINGS;
  private source: BoardSource = { element: null, cssRect: null, manualRect: null };
  private lastFen: string | null = null;
  private lastPlacementSide: string | null = null;
  private sideToMove: 'w' | 'b' = 'w';
  private whiteAtBottom = true;
  private orientationFlipped = false;
  private currentRequestId = 0;
  private scanning = false;
  private destroyed = false;
  private paused = false;
  private watchTimer: number | null = null;
  private observer: MutationObserver | null = null;
  private messageListener: ((message: BackgroundToContent) => void) | null = null;
  private lastSafeAt = 0;
  private learned: LearnedStore = {};
  private learnedLoaded = false;
  private lastBoardHash: number | null = null;
  private unchangedStreak = 0;
  private scanQueued = false;
  private lastScanAt = 0;
  private repositionRaf = 0;

  constructor() {
    this.overlay = new Overlay({
      onRescan: () => this.scan(true),
      onPauseToggle: (paused) => {
        this.paused = paused;
        this.overlay.setStatus(paused ? 'paused' : 'idle', paused ? 'Automatic analysis paused.' : undefined);
        if (!paused) this.scan(false);
      },
      onCopyFen: () => {
        if (this.lastFen) {
          navigator.clipboard.writeText(this.lastFen).catch(() => {});
        }
      },
      onFlip: () => {
        this.orientationFlipped = !this.orientationFlipped;
        this.scan(true);
      },
      onSideChange: (side) => {
        this.sideToMove = side;
        this.reanalyzeSameBoard();
      },
      onSelectRegion: () => this.selectRegion(),
      onOpenOptions: () => chrome.runtime.sendMessage({ type: 'open-options' }),
      onClose: () => this.destroy(),
    });

    this.messageListener = (message: BackgroundToContent) => {
      if (this.destroyed) return;
      switch (message.type) {
        case 'engine-update':
          this.onEngineUpdate(message.update);
          break;
        case 'settings-changed':
          this.settings = message.settings;
          break;
        default:
          break;
      }
    };
    chrome.runtime.onMessage.addListener(this.messageListener);

    // Debug/E2E hooks: allow the page to trigger UI commands that live
    // inside the closed shadow root (used by the automated test-suite).
    document.addEventListener('chess-lens-debug', (e: Event) => {
      if (this.destroyed) return;
      const cmd = (e as CustomEvent).detail;
      if (cmd === 'rescan') this.scan(true);
      else if (cmd === 'select-region') this.selectRegion();
    });

    const reposition = () => {
      cancelAnimationFrame(this.repositionRaf);
      this.repositionRaf = requestAnimationFrame(() => this.updateBarPosition());
    };
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition, { passive: true });
  }

  async start(): Promise<void> {
    updateDebug({ status: 'detecting' });
    this.overlay.mount();
    this.overlay.setPanelOpen(true);
    this.overlay.setStatus('detecting', 'Looking for a chessboard…');
    try {
      this.settings = (await chrome.runtime.sendMessage({ type: 'get-settings' })) ?? DEFAULT_SETTINGS;
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
    await this.scan(true);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopWatching();
    if (this.messageListener) chrome.runtime.onMessage.removeListener(this.messageListener);
    chrome.runtime.sendMessage({ type: 'stop-analysis' }).catch(() => {});
    this.overlay.destroy();
  }

  // --- Capture ---------------------------------------------------------------

  private async captureViewport(): Promise<{ img: RGBAImage; sx: number; sy: number; dataUrl: string } | null> {
    // Hide the overlay ONLY when it could contaminate the board pixels
    // (unknown board rect yet, or actual overlap). Hiding on every automatic
    // re-scan makes the whole UI flicker.
    const mustHide = !this.source.cssRect || this.overlay.overlapsRect(this.source.cssRect);
    if (mustHide) updateDebug({ hideCount: (window.__chessLensDebug?.hideCount ?? 0) + 1 });
    // The arrow always sits on the board: hide it for every capture (a
    // one-frame blink) or the recognizer reads it back as pieces.
    this.overlay.setArrowHidden(true);
    if (mustHide) this.overlay.setHidden(true);
    // Two rAFs get us past the next paint, plus a short real delay so the
    // compositor actually submits the arrow-less frame before the capture
    // (captureVisibleTab can otherwise return the previous composited frame).
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 60));
    let resp: CaptureResponse;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'capture' });
    } finally {
      this.overlay.setArrowHidden(false);
      if (mustHide) this.overlay.setHidden(false);
    }
    if (!resp?.ok || !resp.dataUrl) {
      this.overlay.setStatus('error', `Screen capture failed: ${resp?.error ?? 'unknown error'}`);
      return null;
    }
    const blob = await (await fetch(resp.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    return {
      img: { data: data.data, width: data.width, height: data.height },
      sx: data.width / vw,
      sy: data.height / vh,
      dataUrl: resp.dataUrl,
    };
  }

  private async imageToDataUrl(img: RGBAImage): Promise<string> {
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** Ask the offscreen CNN recognizer (fenshot) to read a board image. */
  private async cnnRecognize(dataUrl: string): Promise<VisionResult | null> {
    try {
      const result: VisionResult = await chrome.runtime.sendMessage({ type: 'vision-recognize', dataUrl });
      return result?.ok ? result : null;
    } catch {
      return null;
    }
  }

  // --- DOM candidates --------------------------------------------------------

  private collectDomCandidates(): { el: Element; rect: DOMRect }[] {
    const out: { el: Element; rect: DOMRect }[] = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const all = document.querySelectorAll<HTMLElement>('body *');
    let inspected = 0;
    for (const el of all) {
      if (inspected++ > 20000) break;
      const w = el.offsetWidth ?? 0;
      const h = el.offsetHeight ?? 0;
      if (w < 160 || h < 160) continue;
      if (Math.abs(w - h) > Math.max(w, h) * 0.1) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 160) continue;
      if (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh) continue;
      out.push({ el, rect });
    }
    // Largest first; drop near-duplicate rects (nested wrappers).
    out.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
    const dedup: { el: Element; rect: DOMRect }[] = [];
    for (const c of out) {
      if (
        dedup.some(
          (d) =>
            Math.abs(d.rect.left - c.rect.left) < 8 &&
            Math.abs(d.rect.top - c.rect.top) < 8 &&
            Math.abs(d.rect.width - c.rect.width) < 12,
        )
      ) {
        continue;
      }
      dedup.push(c);
      if (dedup.length >= 8) break;
    }
    return dedup;
  }

  // --- Scan pipeline ---------------------------------------------------------

  async scan(userInitiated: boolean): Promise<void> {
    if (this.scanning || this.destroyed) {
      this.scanQueued = true;
      return;
    }
    this.scanning = true;
    this.scanQueued = false;
    this.lastScanAt = Date.now();
    try {
      await this.doScan(userInitiated);
    } catch (err) {
      updateDebug({ status: 'error', error: String((err as Error)?.message ?? err) });
      this.overlay.setStatus('error', `Scan failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      this.scanning = false;
      if (this.scanQueued && !this.destroyed) {
        setTimeout(() => this.scan(false), 250);
      }
    }
  }

  private async doScan(userInitiated: boolean): Promise<void> {
    if (userInitiated) this.overlay.setStatus('detecting', 'Scanning…');

    // Cache the "safe" verdict briefly so watch-mode rescans don't pay the
    // 1.2s clock-sampling delay on pages that display static clock text.
    let context: 'safe' | 'live-play' = 'safe';
    if (Date.now() - this.lastSafeAt > 30000) {
      context = await detectPlayContext();
      if (context === 'safe') this.lastSafeAt = Date.now();
    }
    if (context === 'live-play') {
      this.stopWatching();
      chrome.runtime.sendMessage({ type: 'stop-analysis' }).catch(() => {});
      updateDebug({ status: 'blocked' });
      this.overlay.setStatus(
        'blocked',
        'This looks like a competitive game in progress. Chess Lens only analyzes puzzles, studies and finished games.',
      );
      return;
    }

    updateDebug({ scanCount: (window.__chessLensDebug?.scanCount ?? 0) + 1 });
    const captured = await this.captureViewport();
    if (!captured) return;
    const { img, sx, sy } = captured;

    let rect: Rect | null = null;
    let candidates: { el: Element; rect: DOMRect }[] = [];
    if (this.source.manualRect) {
      // The user drew this region: trust it. Only snap the grid sub-pixel;
      // never re-run detection that could reject or replace it.
      const m = this.source.manualRect;
      rect = snapGrid(img, { x: m.x * sx, y: m.y * sy, w: m.w * sx, h: m.h * sy });
    } else {
      const hints: Rect[] = [];
      if (this.source.element?.isConnected) {
        const r = this.source.element.getBoundingClientRect();
        hints.push({ x: r.left * sx, y: r.top * sy, w: r.width * sx, h: r.height * sy });
      }
      candidates = this.collectDomCandidates();
      for (const c of candidates) {
        hints.push({ x: c.rect.left * sx, y: c.rect.top * sy, w: c.rect.width * sx, h: c.rect.height * sy });
      }
      rect = detectBoard(img, hints)?.rect ?? null;
    }

    // Cheap change gate for watch mode: when the board pixels have not
    // changed since the last scan, stop here (no recognizer, no UI churn).
    if (rect) {
      const hash = sampleHash(img, rect);
      if (!userInitiated && hash === this.lastBoardHash) {
        this.unchangedStreak++;
        this.startWatching();
        return;
      }
      this.lastBoardHash = hash;
    }

    // --- Primary recognizer: the fenshot CNN (offscreen, onnxruntime-web).
    // Trained across ~72 piece sets and ~55 board themes; reads any theme.
    // When our geometric detector found the board we send it the crop,
    // otherwise the whole viewport (fenshot has its own detector).
    let screenMatrix: ReturnType<typeof placementToMatrix> | null = null;
    let confidence = 0;
    let recognizerUsed: 'cnn' | 'classic' = 'cnn';
    const vision = await this.cnnRecognize(
      rect ? await this.imageToDataUrl(crop(img, rect)) : captured.dataUrl,
    );
    if (vision?.reliable && vision.placement) {
      try {
        // fenshot reads as if White were at the bottom of the image; its
        // rank-8..1 placement therefore maps directly to screen rows.
        screenMatrix = placementToMatrix(vision.placement);
        confidence = vision.minConfidence ?? 0.7;
        if (!rect && vision.corners) {
          rect = {
            x: vision.corners.x0,
            y: vision.corners.y0,
            w: vision.corners.x1 - vision.corners.x0,
            h: vision.corners.y1 - vision.corners.y0,
          };
        }
      } catch {
        screenMatrix = null;
      }
    }

    if (!rect) {
      updateDebug({ status: 'no-board' });
      this.overlay.setBoardRect(null);
      this.overlay.setStatus(
        'error',
        'No chessboard found on this page. If one is visible, use ⛶ to select it manually.',
      );
      return;
    }

    // Track which DOM element (if any) produced this rect, for repositioning
    // and change watching.
    this.source.element = null;
    for (const c of candidates) {
      const hx = c.rect.left * sx, hy = c.rect.top * sy, hw = c.rect.width * sx;
      if (Math.abs(hx - rect.x) < hw * 0.1 && Math.abs(hy - rect.y) < hw * 0.1 && Math.abs(hw - rect.w) < hw * 0.12) {
        this.source.element = c.el;
        break;
      }
    }
    this.source.cssRect = { x: rect.x / sx, y: rect.y / sy, w: rect.w / sx, h: rect.h / sy };

    // --- Fallback recognizer: classic silhouette matching against bundled
    // templates plus silhouettes learned from previous validated scans on
    // this site (works fully offline of any model, and keeps improving).
    let classicRec: ReturnType<typeof classifyBoard> | null = null;
    if (!screenMatrix) {
      recognizerUsed = 'classic';
      await this.ensureLearnedLoaded();
      const boardImg = crop(img, rect);
      const templates = [...loadTemplates(), ...learnedToTemplates(this.learned)];
      classicRec = classifyBoard(boardImg, templates);
      screenMatrix = classicRec.board;
      confidence = classicRec.confidence;
    }

    const auto = decideOrientation(screenMatrix);
    this.whiteAtBottom = this.orientationFlipped ? !auto.whiteAtBottom : auto.whiteAtBottom;
    const oriented = orientMatrix(screenMatrix, this.whiteAtBottom);
    const validation = validatePosition(oriented);

    this.overlay.setBoardRect(this.source.cssRect, this.whiteAtBottom);

    if (!validation.ok) {
      updateDebug({ status: 'invalid', error: validation.errors.join('; ') });
      this.overlay.setStatus(
        'error',
        `Position not recognized reliably: ${validation.errors.join('; ')}. Try ⟳ or select the board with ⛶.`,
      );
      this.startWatching();
      return;
    }

    // A validated classic read: harvest this theme's silhouettes so the
    // fallback keeps adapting to the site.
    if (classicRec && classicRec.confidence >= HARVEST_MIN_CONFIDENCE && harvestIntoStore(this.learned, classicRec)) {
      this.saveLearned();
    }
    updateDebug({ recognizer: recognizerUsed });

    const fen = buildFen(oriented, this.sideToMove);
    const placementSide = fen.split(' ').slice(0, 2).join(' ');
    const notes: string[] = [];
    const lowConfidence = recognizerUsed === 'cnn' ? confidence < 0.8 : confidence < 0.45;
    if (lowConfidence) notes.push('Low recognition confidence — verify the position.');
    if (validation.warnings.length) notes.push(validation.warnings.join('; '));

    if (placementSide === this.lastPlacementSide && !userInitiated) {
      // Position unchanged: keep current analysis running.
      this.unchangedStreak++;
      this.startWatching();
      return;
    }
    this.unchangedStreak = 0;
    this.lastFen = fen;
    this.lastPlacementSide = placementSide;
    updateDebug({ fen, status: 'analyzing', whiteAtBottom: this.whiteAtBottom, error: null });

    this.overlay.setBestMoveArrow(null, this.whiteAtBottom);
    this.overlay.setStatus('analyzing', notes.length ? notes.join(' ') : undefined);
    await this.requestAnalysis(fen);
    this.startWatching();
  }

  private async requestAnalysis(fen: string): Promise<void> {
    // The request id is generated here, BEFORE the request leaves, so no
    // engine update can ever race ahead of it.
    const requestId = Date.now() * 16 + ((this.currentRequestId + 1) % 16);
    this.currentRequestId = requestId;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'analyze',
        fen,
        options: this.settings.engine,
        requestId,
      });
      if (!resp?.ok) {
        this.overlay.setStatus('error', `Engine error: ${resp?.error ?? 'unavailable'}`);
      }
    } catch (err) {
      this.overlay.setStatus('error', `Engine error: ${String((err as Error)?.message ?? err)}`);
    }
  }

  private reanalyzeSameBoard(): void {
    if (!this.lastFen) return;
    const parts = this.lastFen.split(' ');
    parts[1] = this.sideToMove;
    this.lastFen = parts.join(' ');
    this.lastPlacementSide = parts.slice(0, 2).join(' ');
    this.overlay.setStatus('analyzing');
    this.requestAnalysis(this.lastFen);
  }

  // --- Engine updates --------------------------------------------------------

  private onEngineUpdate(update: EngineUpdate): void {
    if (update.requestId !== this.currentRequestId) return;
    if (update.error) {
      updateDebug({ error: update.error });
      this.overlay.setStatus('error', `Engine: ${update.error}`);
      return;
    }
    if (!update.lines.length) return;
    const main = update.lines[0];
    const chess = this.lastFen ? tryChess(this.lastFen) : null;
    const bestSan = chess && main.pv.length ? sanLine(chess, main.pv.slice(0, 1)) : main.pv[0] ?? '';
    const view = {
      barFraction: scoreToBarFraction(main.score),
      scoreText: formatScore(main.score),
      bestMove: bestSan,
      depth: main.depth,
      nps: main.nps,
      engineName: update.engineName,
      lines: update.lines.map((l: UciInfoLine) => ({
        scoreText: formatScore(l.score),
        moves: chess ? sanLine(chess, l.pv.slice(0, 10)) : l.pv.slice(0, 10).join(' '),
      })),
    };
    this.overlay.setEval(view);
    this.overlay.setBestMoveArrow(main.pv[0] ?? null, this.whiteAtBottom);
    updateDebug({
      depth: main.depth,
      scoreText: view.scoreText,
      bestMove: view.bestMove ?? '',
      engineDone: update.done,
    });
    if (update.done) {
      this.overlay.setStatus(this.paused ? 'paused' : 'idle');
    }
  }

  // --- Watching for board changes -------------------------------------------

  /** Minimum delay between automatic re-scans. Pages that mutate constantly
   *  without the position changing (hover highlights, clocks, ads) back the
   *  cadence off up to 6s; a position change resets it to 1.2s. */
  private watchInterval(): number {
    return Math.min(6000, 1200 * (1 + this.unchangedStreak));
  }

  private startWatching(): void {
    this.stopWatching();
    if (!this.settings.watchBoard || this.paused) return;
    const onChange = () => {
      if (this.paused || this.destroyed) return;
      const wait = this.lastScanAt + this.watchInterval() - Date.now();
      if (this.scanning || wait > 0) {
        this.scanQueued = true;
        if (this.watchTimer === null) {
          this.watchTimer = window.setTimeout(() => {
            this.watchTimer = null;
            if (this.scanQueued) this.scan(false);
          }, Math.max(250, wait));
        }
        return;
      }
      this.scan(false);
    };
    if (this.source.element?.isConnected) {
      this.observer = new MutationObserver(() => onChange());
      this.observer.observe(this.source.element, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } else {
      // No trackable element (manual/scan detection): light polling.
      this.watchTimer = window.setTimeout(() => {
        this.watchTimer = null;
        this.scan(false);
      }, Math.max(2500, this.watchInterval()));
    }
  }

  private stopWatching(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.watchTimer !== null) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
  }

  private updateBarPosition(): void {
    if (this.source.element?.isConnected) {
      const r = this.source.element.getBoundingClientRect();
      this.source.cssRect = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    if (this.source.cssRect) this.overlay.setBoardRect(this.source.cssRect, this.whiteAtBottom);
  }

  // --- Adaptive template persistence ----------------------------------------

  private learnedKey(): string {
    return `learnedTemplates:${location.origin}`;
  }

  private async ensureLearnedLoaded(): Promise<void> {
    if (this.learnedLoaded) return;
    this.learnedLoaded = true;
    try {
      const stored = await chrome.storage.local.get(this.learnedKey());
      const raw = stored[this.learnedKey()];
      if (raw && typeof raw === 'object') this.learned = raw as LearnedStore;
    } catch {
      /* storage unavailable: learning stays session-local */
    }
  }

  private saveLearned(): void {
    chrome.storage.local.set({ [this.learnedKey()]: this.learned }).catch(() => {});
  }

  // --- Manual region selection ----------------------------------------------

  private async selectRegion(): Promise<void> {
    const rect = await this.overlay.beginRegionSelection();
    if (!rect) return;
    this.source.manualRect = rect;
    this.source.element = null;
    await this.scan(true);
    // Refine the manual rect with whatever the detector settled on.
    if (this.source.cssRect) this.source.manualRect = this.source.cssRect;
  }
}

/** Cheap content hash of a board region: sampled pixel sums. */
function sampleHash(img: RGBAImage, rect: { x: number; y: number; w: number; h: number }): number {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(img.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(img.height, Math.round(rect.y + rect.h));
  let h = 2166136261 >>> 0;
  const stepY = Math.max(1, Math.floor((y1 - y0) / 64));
  const stepX = Math.max(1, Math.floor((x1 - x0) / 64));
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * img.width + x) * 4;
      h = (h ^ img.data[i]) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
      h = (h ^ img.data[i + 1]) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h;
}

function tryChess(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/** Convert a UCI move list to a SAN string, tolerating illegal tails. */
function sanLine(base: Chess, uciMoves: string[]): string {
  const chess = new Chess(base.fen());
  const parts: string[] = [];
  for (const uci of uciMoves) {
    try {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? (uci[4] as 'q' | 'r' | 'b' | 'n') : undefined,
      });
      parts.push(move.san);
    } catch {
      parts.push(uci);
      break;
    }
  }
  return parts.join(' ');
}

// --- Bootstrapping -----------------------------------------------------------
// A single global toggle handler owns the instance lifecycle so a toolbar
// click always works: destroy the running instance, or start a fresh one
// (the content script file stays loaded after destroy).
let instance: ChessLens | null = null;

if (!window.__chessLensActive) {
  window.__chessLensActive = true;
  chrome.runtime.onMessage.addListener((message: BackgroundToContent) => {
    if (message.type !== 'toggle-overlay') return;
    if (instance && !instance.isDestroyed) {
      instance.destroy();
      instance = null;
    } else {
      instance = new ChessLens();
      instance.start();
    }
  });
  instance = new ChessLens();
  instance.start();
}
