/** Shadow-DOM overlay: evaluation bar beside the detected board, a small
 *  toggle button, and a collapsible analysis panel. Injected as a fixed
 *  full-viewport host with pointer-events disabled except on controls. */

export interface CssRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PvLine {
  scoreText: string;
  moves: string;
}

export interface EvalView {
  barFraction: number; // 0..1 share for White (bottom by default)
  scoreText: string;
  bestMove?: string;
  depth?: number;
  nps?: number;
  engineName?: string;
  lines: PvLine[];
}

export type OverlayStatus = 'idle' | 'detecting' | 'analyzing' | 'error' | 'blocked' | 'paused';

export interface OverlayCallbacks {
  onRescan(): void;
  onPauseToggle(paused: boolean): void;
  onCopyFen(): void;
  onFlip(): void;
  onSideChange(side: 'w' | 'b'): void;
  onSelectRegion(): void;
  onOpenOptions(): void;
  onClose(): void;
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.hidden { display: none !important; }

.bar-wrap { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.bar {
  width: 16px; flex: 1; border-radius: 8px; overflow: hidden; position: relative;
  background: #3b3733; box-shadow: 0 2px 10px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.08);
}
.bar .white-fill {
  position: absolute; left: 0; right: 0; bottom: 0; background: #f5f2ec;
  height: 50%; transition: height .45s cubic-bezier(.4,.1,.2,1);
}
.bar.flipped .white-fill { bottom: auto; top: 0; }
.bar .zero {
  position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: rgba(128,118,108,.9);
}
.score-chip {
  pointer-events: auto; user-select: none; font-size: 10px; font-weight: 700; letter-spacing: .2px;
  background: rgba(24,22,20,.92); color: #f0ece5; border-radius: 6px; padding: 2px 5px;
  box-shadow: 0 2px 8px rgba(0,0,0,.4); white-space: nowrap;
}
.toggle {
  pointer-events: auto; cursor: pointer; width: 24px; height: 24px; border: none; border-radius: 7px;
  background: rgba(24,22,20,.92); color: #d8d2c8; font-size: 12px; line-height: 1;
  box-shadow: 0 2px 8px rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center;
}
.toggle:hover { background: rgba(45,42,38,.95); color: #fff; }

.panel {
  position: absolute; width: 292px; pointer-events: auto;
  background: rgba(22,21,19,.94); color: #ece7df; border-radius: 14px;
  box-shadow: 0 10px 40px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.07);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  padding: 12px 14px; font-size: 12px;
}
.panel header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.panel header .title { font-weight: 700; font-size: 12px; letter-spacing: .3px; color: #cfc9bf; flex: 1; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #8f8a82; }
.dot.analyzing { background: #58b368; animation: pulse 1.2s infinite; }
.dot.error, .dot.blocked { background: #d95c4a; }
.dot.paused { background: #d9a94a; }
@keyframes pulse { 50% { opacity: .35; } }
.iconbtn {
  cursor: pointer; border: none; background: transparent; color: #a49d92; font-size: 13px;
  width: 22px; height: 22px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
}
.iconbtn:hover { background: rgba(255,255,255,.08); color: #fff; }

.headline { display: flex; align-items: baseline; gap: 10px; margin: 2px 0 8px; }
.headline .eval { font-size: 26px; font-weight: 800; letter-spacing: -.5px; }
.headline .best { font-size: 15px; font-weight: 600; color: #9ecf8f; }
.headline .best .lbl { font-size: 10px; font-weight: 500; color: #8f8a82; margin-right: 5px; }

.pvs { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.pv { display: flex; gap: 8px; align-items: baseline; background: rgba(255,255,255,.045); border-radius: 8px; padding: 4px 8px; }
.pv .s { font-weight: 700; min-width: 42px; color: #dcd6cc; }
.pv .m { color: #a8a196; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-variant-numeric: tabular-nums; }

.meta { display: flex; gap: 10px; color: #7f7970; font-size: 10.5px; margin-bottom: 8px; flex-wrap: wrap; }
.note { color: #c8b37a; font-size: 11px; margin-bottom: 8px; line-height: 1.45; }
.note.err { color: #e08a7a; }

.controls { display: flex; gap: 6px; flex-wrap: wrap; }
.btn {
  pointer-events: auto; cursor: pointer; border: none; border-radius: 8px; padding: 5px 9px;
  background: rgba(255,255,255,.08); color: #ddd7cd; font-size: 11px; font-weight: 600;
  display: inline-flex; align-items: center; gap: 5px;
}
.btn:hover { background: rgba(255,255,255,.15); color: #fff; }
.btn.active { background: rgba(88,179,104,.25); color: #b9e3b0; }
.btn.side-b { background: rgba(0,0,0,.5); color: #eee; }

.arrow-layer { position: absolute; pointer-events: none; }

.select-veil {
  position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; z-index: 2147483647;
  background: rgba(0,0,0,.25);
}
.select-rect { position: absolute; border: 2px solid #58b368; background: rgba(88,179,104,.15); border-radius: 4px; }
.select-hint {
  position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
  background: rgba(22,21,19,.95); color: #ece7df; padding: 8px 14px; border-radius: 10px; font-size: 13px;
  box-shadow: 0 6px 24px rgba(0,0,0,.5);
}
`;

export class Overlay {
  private host: HTMLDivElement;
  private root: HTMLDivElement;
  private barWrap: HTMLDivElement;
  private arrowLayer: SVGSVGElement;
  private arrowOn = true;
  private bestMoveUci: string | null = null;
  private arrowWhiteAtBottom = true;
  private bar: HTMLDivElement;
  private whiteFill: HTMLDivElement;
  private scoreChip: HTMLDivElement;
  private toggleBtn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private els: Record<string, HTMLElement> = {};
  private cb: OverlayCallbacks;
  private panelOpen = false;
  private paused = false;
  private side: 'w' | 'b' = 'w';
  private boardRect: CssRect | null = null;

  constructor(cb: OverlayCallbacks) {
    this.cb = cb;
    this.host = document.createElement('div');
    this.host.id = 'chess-lens-host';
    const shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'root';
    shadow.appendChild(this.root);

    this.arrowLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.arrowLayer.classList.add('arrow-layer', 'hidden');
    this.arrowLayer.setAttribute('viewBox', '0 0 8 8');
    this.root.appendChild(this.arrowLayer);

    this.barWrap = document.createElement('div');
    this.barWrap.className = 'bar-wrap hidden';
    this.bar = document.createElement('div');
    this.bar.className = 'bar';
    this.whiteFill = document.createElement('div');
    this.whiteFill.className = 'white-fill';
    const zero = document.createElement('div');
    zero.className = 'zero';
    this.bar.append(this.whiteFill, zero);
    this.scoreChip = document.createElement('div');
    this.scoreChip.className = 'score-chip';
    this.scoreChip.textContent = '…';
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'toggle';
    this.toggleBtn.textContent = '▾';
    this.toggleBtn.title = 'Show analysis';
    this.toggleBtn.addEventListener('click', () => this.setPanelOpen(!this.panelOpen));
    this.barWrap.append(this.bar, this.scoreChip, this.toggleBtn);
    this.root.appendChild(this.barWrap);

    this.panel = document.createElement('div');
    this.panel.className = 'panel hidden';
    this.panel.innerHTML = `
      <header>
        <span class="dot" id="dot"></span>
        <span class="title">CHESS LENS</span>
        <button class="iconbtn" id="btn-options" title="Settings">⚙</button>
        <button class="iconbtn" id="btn-close" title="Close">✕</button>
      </header>
      <div class="headline">
        <span class="eval" id="eval">–</span>
        <span class="best" id="best"></span>
      </div>
      <div class="pvs" id="pvs"></div>
      <div class="meta" id="meta"></div>
      <div class="note hidden" id="note"></div>
      <div class="controls">
        <button class="btn" id="btn-rescan" title="Re-scan the board">⟳ Scan</button>
        <button class="btn" id="btn-pause" title="Pause automatic analysis">⏸</button>
        <button class="btn" id="btn-side" title="Side to move">White to move</button>
        <button class="btn active" id="btn-arrow" title="Show best move arrow on the board">➤</button>
        <button class="btn" id="btn-flip" title="Flip detected orientation">⇅</button>
        <button class="btn" id="btn-fen" title="Copy FEN">FEN</button>
        <button class="btn" id="btn-region" title="Select board region manually">⛶</button>
      </div>`;
    this.root.appendChild(this.panel);

    for (const el of this.panel.querySelectorAll<HTMLElement>('[id]')) this.els[el.id] = el;
    this.els['btn-close'].addEventListener('click', () => this.cb.onClose());
    this.els['btn-options'].addEventListener('click', () => this.cb.onOpenOptions());
    this.els['btn-rescan'].addEventListener('click', () => this.cb.onRescan());
    this.els['btn-fen'].addEventListener('click', () => this.cb.onCopyFen());
    this.els['btn-flip'].addEventListener('click', () => this.cb.onFlip());
    this.els['btn-arrow'].addEventListener('click', () => {
      this.arrowOn = !this.arrowOn;
      this.els['btn-arrow'].classList.toggle('active', this.arrowOn);
      this.renderArrow();
    });
    this.els['btn-region'].addEventListener('click', () => this.cb.onSelectRegion());
    this.els['btn-pause'].addEventListener('click', () => {
      this.paused = !this.paused;
      this.updatePauseButton();
      this.cb.onPauseToggle(this.paused);
    });
    this.els['btn-side'].addEventListener('click', () => {
      this.side = this.side === 'w' ? 'b' : 'w';
      this.updateSideButton();
      this.cb.onSideChange(this.side);
    });
  }

  mount(): void {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
  }

  destroy(): void {
    this.host.remove();
  }

  setHidden(hidden: boolean): void {
    this.host.style.visibility = hidden ? 'hidden' : '';
  }

  /** The best-move arrow lies ON the board by design, so it must be hidden
   *  during every capture or the recognizer reads it as pieces. */
  setArrowHidden(hidden: boolean): void {
    // display:none (not visibility): the layer must leave the compositor
    // entirely before captureVisibleTab grabs the next frame.
    this.arrowLayer.style.display = hidden ? 'none' : '';
  }

  /** Does any visible overlay part intersect the given viewport rect?
   *  Used to decide whether the overlay must be hidden during a screen
   *  capture: hiding on every automatic re-scan makes the UI flicker, so we
   *  only hide when we would actually contaminate the board pixels. */
  overlapsRect(rect: CssRect, margin = 2): boolean {
    const boxes: DOMRect[] = [];
    if (!this.barWrap.classList.contains('hidden')) boxes.push(this.barWrap.getBoundingClientRect());
    if (!this.panel.classList.contains('hidden')) boxes.push(this.panel.getBoundingClientRect());
    return boxes.some(
      (b) =>
        b.right > rect.x - margin &&
        b.left < rect.x + rect.w + margin &&
        b.bottom > rect.y - margin &&
        b.top < rect.y + rect.h + margin,
    );
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.panel.classList.toggle('hidden', !open);
    this.toggleBtn.textContent = open ? '▴' : '▾';
    this.position();
  }

  setSide(side: 'w' | 'b'): void {
    this.side = side;
    this.updateSideButton();
  }

  private updateSideButton(): void {
    const b = this.els['btn-side'];
    b.textContent = this.side === 'w' ? 'White to move' : 'Black to move';
    b.classList.toggle('side-b', this.side === 'b');
  }

  private updatePauseButton(): void {
    const b = this.els['btn-pause'];
    b.textContent = this.paused ? '▶' : '⏸';
    b.classList.toggle('active', this.paused);
    b.title = this.paused ? 'Resume automatic analysis' : 'Pause automatic analysis';
  }

  /** Place the eval bar to the left of the board (CSS pixels, viewport). */
  setBoardRect(rect: CssRect | null, whiteAtBottom = true): void {
    this.boardRect = rect;
    this.bar.classList.toggle('flipped', !whiteAtBottom);
    this.position();
  }

  private position(): void {
    if (!this.boardRect) {
      this.barWrap.classList.add('hidden');
      this.arrowLayer.classList.add('hidden');
      if (this.panelOpen) {
        this.panel.style.left = '18px';
        this.panel.style.top = '18px';
      }
      return;
    }
    const r = this.boardRect;
    const barW = 26;
    let left = r.x - barW - 8;
    if (left < 4) left = Math.min(r.x + r.w + 8, window.innerWidth - barW - 4);
    this.barWrap.classList.remove('hidden');
    this.barWrap.style.left = `${left}px`;
    this.barWrap.style.top = `${r.y}px`;
    this.barWrap.style.height = `${r.h}px`;
    this.barWrap.style.width = `${barW}px`;

    Object.assign(this.arrowLayer.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.w}px`,
      height: `${r.h}px`,
    });
    this.renderArrow();

    // Panel placement: NEVER over the board when any side fits (a panel over
    // the board would force an overlay hide on every capture -> flicker).
    const panelW = 292;
    const panelH = this.panel.offsetHeight || 240;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampY = (y: number) => Math.max(8, Math.min(vh - panelH - 8, y));
    const barOnLeft = left < r.x;
    const candidates: [number, number][] = [
      // Outside the bar, same side as the bar.
      barOnLeft ? [left - panelW - 10, r.y] : [left + barW + 10, r.y],
      // The other side of the board.
      barOnLeft ? [r.x + r.w + 10, r.y] : [r.x - panelW - 10, r.y],
      // Below, then above the board.
      [r.x, r.y + r.h + 10],
      [r.x, r.y - panelH - 10],
    ];
    let px = 4;
    let py = clampY(r.y);
    let placed = false;
    for (const [cx, cy] of candidates) {
      const x = Math.max(4, Math.min(vw - panelW - 4, cx));
      const y = clampY(cy);
      const overlapsBoard =
        x + panelW > r.x - 4 && x < r.x + r.w + 4 && y + panelH > r.y - 4 && y < r.y + r.h + 4;
      if (!overlapsBoard) {
        px = x;
        py = y;
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Nothing fits beside the board (tiny viewport): bottom-left corner.
      px = 4;
      py = clampY(vh - panelH - 8);
    }
    this.panel.style.left = `${px}px`;
    this.panel.style.top = `${py}px`;
  }

  setStatus(status: OverlayStatus, message?: string): void {
    const dot = this.els['dot'];
    dot.className = `dot ${status}`;
    const note = this.els['note'];
    if (message) {
      note.textContent = message;
      note.classList.remove('hidden');
      note.classList.toggle('err', status === 'error' || status === 'blocked');
    } else {
      note.classList.add('hidden');
    }
    if (status === 'blocked' || status === 'error') this.setPanelOpen(true);
  }

  setEval(view: EvalView): void {
    const pct = Math.round(view.barFraction * 1000) / 10;
    this.whiteFill.style.height = `${pct}%`;
    this.scoreChip.textContent = view.scoreText;
    this.els['eval'].textContent = view.scoreText;
    this.els['best'].innerHTML = view.bestMove
      ? `<span class="lbl">BEST</span>${escapeHtml(view.bestMove)}`
      : '';
    const pvs = this.els['pvs'];
    pvs.innerHTML = '';
    for (const line of view.lines) {
      const div = document.createElement('div');
      div.className = 'pv';
      const s = document.createElement('span');
      s.className = 's';
      s.textContent = line.scoreText;
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = line.moves;
      m.title = line.moves;
      div.append(s, m);
      pvs.appendChild(div);
    }
    const meta: string[] = [];
    if (view.depth) meta.push(`depth ${view.depth}`);
    if (view.nps) meta.push(`${formatNps(view.nps)} n/s`);
    if (view.engineName) meta.push(view.engineName);
    this.els['meta'].textContent = meta.join('  ·  ');
  }

  /** Show (or clear) the engine's best move as an arrow over the board.
   *  `uci` is a long-algebraic move like "e2e4". */
  setBestMoveArrow(uci: string | null, whiteAtBottom: boolean): void {
    this.bestMoveUci = uci && /^[a-h][1-8][a-h][1-8]/.test(uci) ? uci : null;
    this.arrowWhiteAtBottom = whiteAtBottom;
    this.renderArrow();
  }

  private renderArrow(): void {
    const show = this.arrowOn && this.bestMoveUci && this.boardRect;
    this.arrowLayer.classList.toggle('hidden', !show);
    this.arrowLayer.innerHTML = '';
    if (!show) return;
    const uci = this.bestMoveUci!;
    const square = (file: number, rank: number): [number, number] =>
      this.arrowWhiteAtBottom ? [file + 0.5, 7.5 - rank] : [7.5 - file, rank + 0.5];
    const [x1, y1] = square(uci.charCodeAt(0) - 97, uci.charCodeAt(1) - 49);
    const [x2, y2] = square(uci.charCodeAt(2) - 97, uci.charCodeAt(3) - 49);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    const ux = dx / len, uy = dy / len;
    // Shorten the tail off the source square center and leave room for the head.
    const sx = x1 + ux * 0.32, sy = y1 + uy * 0.32;
    const head = 0.42;
    const ex = x2 - ux * head, ey = y2 - uy * head;
    const px = -uy, py = ux;
    const ns = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('fill', 'rgba(21,120,27,0.85)');
    const line = document.createElementNS(ns, 'polygon');
    const hw = 0.11;
    line.setAttribute(
      'points',
      `${sx + px * hw},${sy + py * hw} ${ex + px * hw},${ey + py * hw} ${ex - px * hw},${ey - py * hw} ${sx - px * hw},${sy - py * hw}`,
    );
    const tip = document.createElementNS(ns, 'polygon');
    const bw = 0.28;
    tip.setAttribute(
      'points',
      `${x2 - ux * 0.06},${y2 - uy * 0.06} ${ex + px * bw},${ey + py * bw} ${ex - px * bw},${ey - py * bw}`,
    );
    g.append(line, tip);
    this.arrowLayer.appendChild(g);
  }

  /** Interactive drag-selection of a region; resolves with CSS-px rect.
   *  Listeners live on window (capture) so a release outside the page, a
   *  lost pointer, Esc, a second Escape-hatch click, or a 60s timeout can
   *  never leave the full-page veil stuck blocking the site. */
  beginRegionSelection(): Promise<CssRect | null> {
    return new Promise((resolve) => {
      const veil = document.createElement('div');
      veil.className = 'select-veil';
      const hint = document.createElement('div');
      hint.className = 'select-hint';
      hint.textContent = 'Drag a rectangle around the chessboard — Esc or click to cancel';
      const rectEl = document.createElement('div');
      rectEl.className = 'select-rect hidden';
      veil.append(hint, rectEl);
      this.root.appendChild(veil);

      let sx = 0, sy = 0, dragging = false, done = false;
      const cleanup: (() => void)[] = [];
      const finish = (result: CssRect | null) => {
        if (done) return;
        done = true;
        for (const fn of cleanup) fn();
        veil.remove();
        resolve(result);
      };
      const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
        window.addEventListener(type, fn, true);
        cleanup.push(() => window.removeEventListener(type, fn, true));
      };

      const timeout = setTimeout(() => finish(null), 60000);
      cleanup.push(() => clearTimeout(timeout));

      on('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      });
      on('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        rectEl.classList.remove('hidden');
        Object.assign(rectEl.style, { left: `${sx}px`, top: `${sy}px`, width: '0px', height: '0px' });
      });
      on('pointermove', (e) => {
        if (!dragging) return;
        const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
        const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
        Object.assign(rectEl.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      });
      const end = (cx: number, cy: number) => {
        if (!dragging) return finish(null);
        const x = Math.min(sx, cx), y = Math.min(sy, cy);
        const w = Math.abs(cx - sx), h = Math.abs(cy - sy);
        // A tiny drag is a click: treat as cancel.
        finish(w > 40 && h > 40 ? { x, y, w, h } : null);
      };
      on('pointerup', (e) => {
        e.preventDefault();
        e.stopPropagation();
        end(e.clientX, e.clientY);
      });
      on('pointercancel', () => finish(null));
      on('blur', () => finish(null));
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatNps(nps: number): string {
  if (nps >= 1e6) return `${(nps / 1e6).toFixed(1)}M`;
  if (nps >= 1e3) return `${Math.round(nps / 1e3)}k`;
  return String(nps);
}
