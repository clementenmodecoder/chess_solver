/** Content script: orchestrates capture -> board detection -> recognition ->
 *  FEN -> engine analysis, and drives the overlay UI. Injected on demand via
 *  the toolbar action (activeTab), never automatically. */

import { Chess } from 'chess.js';
import { buildFen, placementToMatrix } from '../chess/fen';
import { formatScore, scoreToBarFraction, type UciInfoLine } from '../engine/uci';
import type { BackgroundToContent, EngineUpdate, ScanMessage, ScanResponse, Settings } from '../messages';
import type { LearnedStore } from '../vision/learning';
import { DEFAULT_SETTINGS } from '../messages';
import { Overlay, type CssRect } from './overlay';
import { detectPlayContext } from './safety';
import { inferSideFromHistory } from '../chess/transition';

// Build token: after a dev auto-reload the orphaned script of the previous
// build still holds the old flag, so the guard compares tokens, not booleans.
declare const __CHESS_LENS_BUILD__: string;
const BUILD_TOKEN = typeof __CHESS_LENS_BUILD__ === 'string' ? __CHESS_LENS_BUILD__ : 'release';

declare global {
  interface Window {
    __chessLensActive?: string;
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
      /** Raw recognition before validation (screen orientation, ranks top->bottom). */
      rawPlacement?: string;
      cnnReliable?: boolean;
      cnnMinConfidence?: number;
      cnnPlacement?: string;
      boardRect?: { x: number; y: number; w: number; h: number } | null;
      build?: string;
      timings?: Record<string, number>;
      /** In-page step marks of the current scan (ms since scan start). */
      marks?: Record<string, number>;
      /** How many times the overlay was hidden for a capture (flicker probe). */
      hideCount?: number;
      scanCount?: number;
    };
  }
}

function updateDebug(partial: Partial<NonNullable<Window['__chessLensDebug']>>): void {
  if (!window.__chessLensDebug) {
    window.__chessLensDebug = {
      build: BUILD_TOKEN,
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

/** Depth below which the best move is not shown yet. */
const MIN_TRUSTED_DEPTH = 14;

let scanStartedAt = 0;
function mark(name: string): void {
  const marks = { ...(window.__chessLensDebug?.marks ?? {}), [name]: Math.round(performance.now() - scanStartedAt) };
  updateDebug({ marks });
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
  /** Recent analyzed FENs (oldest first) for side-to-move inference. */
  private fenHistory: string[] = [];
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
  private debugListener: ((e: Event) => void) | null = null;
  private blocked = false;
  private lastSafeAt = 0;
  private learned: LearnedStore = {};
  private learnedLoaded = false;
  /** Hash of the last arrow-inclusive probe capture of the board region. */
  private lastProbeHash: number | null = null;
  private unchangedStreak = 0;
  private scanQueued = false;
  private lastScanAt = 0;
  private repositionRaf = 0;
  private engineRetried = false;

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
      onOpenReview: () => chrome.runtime.sendMessage({ type: 'open-review' }),
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
    this.debugListener = (e: Event) => {
      if (this.destroyed) return;
      const cmd = (e as CustomEvent).detail;
      if (cmd === 'rescan') this.scan(true);
      else if (cmd === 'select-region') this.selectRegion();
      else if (cmd === 'engine-diag') {
        chrome.runtime
          .sendMessage({ type: 'engine-diag' })
          .then((diag) => {
            document.documentElement.dataset.chessLensEngineDiag = JSON.stringify({
              ...diag,
              currentRequestId: this.currentRequestId,
              lastFen: this.lastFen,
              settings: this.settings,
            });
          })
          .catch((err) => {
            document.documentElement.dataset.chessLensEngineDiag = JSON.stringify({ error: String(err?.message ?? err) });
          });
      }
    };
    document.addEventListener('chess-lens-debug', this.debugListener);

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
    if (this.debugListener) document.removeEventListener('chess-lens-debug', this.debugListener);
    chrome.runtime.sendMessage({ type: 'stop-analysis' }).catch(() => {});
    this.overlay.destroy();
  }

  // --- Capture + offscreen scan ---------------------------------------------

  /** Ask the service worker to capture the tab and the offscreen host to
   *  run the vision pipeline on it. No pixel work happens in the page. */
  private async runScan(req: Omit<ScanMessage, 'viewport' | 'learned'>, forRecognition: boolean): Promise<ScanResponse> {
    if (forRecognition) await this.ensureLearnedLoaded();
    // Hide the overlay ONLY when it could contaminate the board pixels
    // (unknown board rect yet, or actual overlap). The best-move arrow sits
    // on the board: hide it before a recognition capture (one-frame blink);
    // a probe capture keeps it (static between scans, so the change hash is
    // unaffected).
    const mustHide = forRecognition && (!this.source.cssRect || this.overlay.overlapsRect(this.source.cssRect));
    if (mustHide) updateDebug({ hideCount: (window.__chessLensDebug?.hideCount ?? 0) + 1 });
    if (forRecognition) this.overlay.setArrowHidden(true);
    if (mustHide) this.overlay.setHidden(true);
    if (forRecognition) {
      // Two rAFs get us past the next paint, plus a short real delay so the
      // compositor actually submits the arrow-less frame before the capture.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 60));
    }
    const message: ScanMessage = {
      ...req,
      viewport: { w: window.visualViewport?.width ?? window.innerWidth, h: window.visualViewport?.height ?? window.innerHeight },
      learned: forRecognition ? this.learned : {},
    };
    try {
      const resp: ScanResponse | undefined = await chrome.runtime.sendMessage({ type: 'vision-scan', request: message });
      if (resp?.learned) {
        this.learned = resp.learned;
        chrome.storage.local.set({ [this.learnedKey()]: this.learned }).catch(() => {});
      }
      return resp ?? { ok: false, error: 'no response from the extension' };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    } finally {
      if (forRecognition) this.overlay.setArrowHidden(false);
      if (mustHide) this.overlay.setHidden(false);
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
      // Keep watching even when a scan failed or found no board (the board
      // may scroll back into view); only a live-play block stops the watch.
      if (!this.destroyed && !this.blocked && !this.observer && this.watchTimer === null) {
        this.startWatching();
      }
      if (this.scanQueued && !this.destroyed) {
        setTimeout(() => this.scan(false), 250);
      }
    }
  }

  private async doScan(userInitiated: boolean): Promise<void> {
    scanStartedAt = performance.now();
    updateDebug({ marks: {} });
    mark('start');
    if (userInitiated) this.overlay.setStatus('detecting', 'Scanning…');

    // Cache the "safe" verdict briefly so watch-mode rescans don't pay the
    // 1.2s clock-sampling delay on pages that display static clock text.
    let context: 'safe' | 'live-play' = 'safe';
    if (Date.now() - this.lastSafeAt > 30000) {
      context = await detectPlayContext();
      if (context === 'safe') this.lastSafeAt = Date.now();
    }
    mark('context');
    if (context === 'live-play') {
      this.blocked = true;
      this.stopWatching();
      chrome.runtime.sendMessage({ type: 'stop-analysis' }).catch(() => {});
      updateDebug({ status: 'blocked' });
      this.overlay.setStatus(
        'blocked',
        'This looks like a competitive game in progress. Chess Lens only analyzes puzzles, studies and finished games.',
      );
      return;
    }

    this.blocked = false;
    // A hidden tab cannot be captured (and its timers are throttled): wait
    // for it to come back instead of piling up failing scans.
    if (document.visibilityState === 'hidden') {
      updateDebug({ status: 'hidden' });
      this.overlay.setStatus('paused', 'Tab not visible — analysis resumes when you come back.');
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onVisible);
        if (!this.destroyed && !this.paused) this.scan(true);
      };
      document.addEventListener('visibilitychange', onVisible);
      return;
    }
    updateDebug({ scanCount: (window.__chessLensDebug?.scanCount ?? 0) + 1 });

    // Watch-mode fast path: with a known board rect, a probe capture hashed
    // in the offscreen host decides whether anything changed before any
    // detection or recognition work (pages like chess.com mutate their DOM
    // constantly without the position changing).
    if (!userInitiated && this.source.cssRect && !this.source.manualRect) {
      const probe = await this.runScan(
        { hints: [], manualRect: null, orientationFlipped: this.orientationFlipped, probeRect: this.source.cssRect, lastHash: this.lastProbeHash },
        false,
      );
      if (probe.ok && probe.unchanged) {
        this.unchangedStreak++;
        this.startWatching();
        return;
      }
      // Something changed: let the board settle (move animations take
      // ~200 ms) and only recognize once two consecutive probes agree, or
      // a piece in flight gets read on the wrong square.
      let hash = probe.ok ? probe.hash : undefined;
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 280));
        const again = await this.runScan(
          { hints: [], manualRect: null, orientationFlipped: this.orientationFlipped, probeRect: this.source.cssRect, lastHash: hash ?? null },
          false,
        );
        if (!again.ok) break;
        if (again.unchanged) break;
        hash = again.hash;
      }
      if (hash !== undefined) this.lastProbeHash = hash;
    }

    mark('probe');
    const hints: CssRect[] = [];
    let candidates: { el: Element; rect: DOMRect }[] = [];
    if (!this.source.manualRect) {
      if (this.source.element?.isConnected) {
        const r = this.source.element.getBoundingClientRect();
        hints.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
      candidates = this.collectDomCandidates();
      for (const c of candidates) hints.push({ x: c.rect.left, y: c.rect.top, w: c.rect.width, h: c.rect.height });
    }
    mark('candidates');
    const result = await this.runScan(
      { hints, manualRect: this.source.manualRect, orientationFlipped: this.orientationFlipped, probeRect: null, lastHash: null },
      true,
    );
    mark('scan-response');
    if (!result.ok) {
      updateDebug({ status: 'error', error: result.error ?? 'scan failed', timings: { capture: result.captureMs ?? -1, total: result.totalMs ?? -1 } });
      this.overlay.setStatus('error', `Scan failed: ${result.error ?? 'unknown error'}`);
      // Transient (capture timeout, host restarting): retry shortly.
      setTimeout(() => !this.destroyed && this.scan(false), 2000);
      return;
    }
    updateDebug({
      cnnReliable: result.cnn?.reliable ?? false,
      cnnMinConfidence: result.cnn?.minConfidence,
      cnnPlacement: result.cnn?.placement,
      recognizer: result.recognizer,
      rawPlacement: result.rawPlacement ?? undefined,
      boardRect: result.rect ?? null,
      timings: { ...(result.timings ?? {}), capture: result.captureMs ?? -1, total: result.totalMs ?? -1 },
    });
    if (result.hash !== undefined) this.lastProbeHash = result.hash;

    const rect = result.rect ?? null;
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
      if (Math.abs(c.rect.left - rect.x) < rect.w * 0.1 && Math.abs(c.rect.top - rect.y) < rect.w * 0.1 && Math.abs(c.rect.width - rect.w) < rect.w * 0.12) {
        this.source.element = c.el;
        break;
      }
    }
    this.source.cssRect = rect;
    this.whiteAtBottom = result.whiteAtBottom ?? true;
    this.overlay.setBoardRect(this.source.cssRect, this.whiteAtBottom);

    const validation = result.validation ?? { ok: false, errors: ['unknown'], warnings: [] };
    if (!validation.ok || !result.placement) {
      updateDebug({ status: 'invalid', error: validation.errors.join('; ') });
      this.overlay.setStatus(
        'error',
        `Position not recognized reliably: ${validation.errors.join('; ')}. Try ⟳ or select the board with ⛶.`,
      );
      this.startWatching();
      return;
    }
    const oriented = placementToMatrix(result.placement);
    const notes: string[] = [];
    if (result.lowConfidence) notes.push('Low recognition confidence — verify the position.');
    if (validation.warnings.length) notes.push(validation.warnings.join('; '));


    const fen = buildFen(oriented, this.sideToMove);
    const placementSide = fen.split(' ').slice(0, 2).join(' ');

    if (placementSide === this.lastPlacementSide && !userInitiated) {
      // Position unchanged: keep current analysis running.
      this.unchangedStreak++;
      this.startWatching();
      return;
    }
    this.unchangedStreak = 0;
    // A position change caused by one legal move reveals the side to move.
    if (this.fenHistory.length) {
      const inferred = inferSideFromHistory(this.fenHistory, placementSide);
      if (inferred && inferred !== this.sideToMove) {
        this.sideToMove = inferred;
        this.overlay.setSide(inferred);
      }
    }
    const finalFen = buildFen(oriented, this.sideToMove);
    // Invalidate the running request right away: an update from the old
    // search arriving before the new request id exists would otherwise be
    // SAN-converted against the new position (and shown as raw UCI).
    this.currentRequestId = -1;
    this.lastFen = finalFen;
    this.fenHistory.push(finalFen);
    if (this.fenHistory.length > 4) this.fenHistory.shift();
    this.lastPlacementSide = finalFen.split(' ').slice(0, 2).join(' ');
    updateDebug({ fen: this.lastFen, status: 'analyzing', whiteAtBottom: this.whiteAtBottom, error: null });

    this.overlay.setBestMoveArrow(null, this.whiteAtBottom);
    this.overlay.setStatus('analyzing', notes.length ? notes.join(' ') : undefined);
    mark('ui');
    await this.requestAnalysis(this.lastFen);
    mark('analysis-requested');
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
    if (this.fenHistory.length) this.fenHistory[this.fenHistory.length - 1] = this.lastFen;
    this.lastPlacementSide = parts.slice(0, 2).join(' ');
    updateDebug({ fen: this.lastFen, status: 'analyzing' });
    this.overlay.setStatus('analyzing');
    this.requestAnalysis(this.lastFen);
  }

  // --- Engine updates --------------------------------------------------------

  private onEngineUpdate(update: EngineUpdate): void {
    if (update.requestId !== this.currentRequestId) return;
    if (update.error) {
      updateDebug({ error: update.error });
      this.overlay.setStatus('error', `Engine: ${update.error}`);
      // A crashed engine is rebuilt on the next request: retry once.
      if (/crashed/i.test(update.error) && this.lastFen && !this.engineRetried) {
        this.engineRetried = true;
        setTimeout(() => this.lastFen && this.requestAnalysis(this.lastFen), 500);
      }
      return;
    }
    this.engineRetried = false;
    if (!update.lines.length) return;
    const main = update.lines[0];
    const chess = this.lastFen ? tryChess(this.lastFen) : null;
    const bestSan = chess && main.pv.length ? sanLine(chess, main.pv.slice(0, 1)) : main.pv[0] ?? '';
    // Shallow searches change their mind every few plies: only commit to a
    // "best move" (text + arrow) once the search is deep enough to trust.
    const trusted = update.done || main.depth >= MIN_TRUSTED_DEPTH;
    const view = {
      barFraction: scoreToBarFraction(main.score),
      scoreText: formatScore(main.score),
      bestMove: trusted ? bestSan : '',
      thinking: !trusted,
      depth: main.depth,
      nps: main.nps,
      engineName: update.engineName,
      lines: update.lines.map((l: UciInfoLine) => ({
        scoreText: formatScore(l.score),
        moves: chess ? sanLine(chess, l.pv.slice(0, 10)) : l.pv.slice(0, 10).join(' '),
      })),
    };
    this.overlay.setEval(view);
    this.overlay.setBestMoveArrow(trusted ? (main.pv[0] ?? null) : null, this.whiteAtBottom);
    updateDebug({
      depth: main.depth,
      scoreText: view.scoreText,
      bestMove: trusted ? (view.bestMove ?? '') : '',
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

  // --- Manual region selection ----------------------------------------------

  private async selectRegion(): Promise<void> {
    const rect = await this.overlay.beginRegionSelection();
    if (!rect) {
      // Cancelled: if a manual region was active, drop it and go back to
      // automatic detection (the intuitive way to leave manual mode).
      if (this.source.manualRect) {
        this.source.manualRect = null;
        await this.scan(true);
      }
      return;
    }
    this.source.manualRect = rect;
    this.source.element = null;
    await this.scan(true);
    // Refine the manual rect with whatever the detector settled on.
    if (this.source.cssRect) this.source.manualRect = this.source.cssRect;
  }
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

if (window.__chessLensActive !== BUILD_TOKEN) {
  window.__chessLensActive = BUILD_TOKEN;
  // Evict any instance of a previous build still running in this tab (an
  // extension reload orphans its content scripts; they keep their timers).
  document.dispatchEvent(new CustomEvent('chess-lens-teardown', { detail: BUILD_TOKEN }));
  document.getElementById('chess-lens-host')?.remove();
  document.addEventListener('chess-lens-teardown', (e) => {
    if ((e as CustomEvent).detail === BUILD_TOKEN) return;
    if (instance && !instance.isDestroyed) instance.destroy();
    instance = null;
    window.__chessLensActive = undefined;
  });
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
