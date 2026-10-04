/** Game Review page: PGN in, full report out (accuracy, move classes, eval
 *  graph, key moments, navigable board with the best move on every ply). */

import { reviewGame, type ReviewResult, type ReviewedMove, formatCp } from './analyze';
import { CLASS_LABEL, CLASS_SYMBOL, winPercent, type MoveClass } from './classify';
import { ReviewEngine } from './engine-client';
import { renderBoard } from './board';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const CLASS_COLOR: Record<MoveClass, string> = {
  brilliant: '#1baca6',
  great: '#5b8bb0',
  best: '#81b64c',
  excellent: '#96bc4b',
  good: '#96af8b',
  book: '#a88865',
  inaccuracy: '#f7c631',
  mistake: '#ffa459',
  miss: '#ff7769',
  blunder: '#fa412d',
};

const STRENGTH = {
  fast: { depth: 14, movetimeMs: 400 },
  normal: { depth: 18, movetimeMs: 1000 },
  deep: { depth: 22, movetimeMs: 3000 },
} as const;

const engine = new ReviewEngine();
let review: ReviewResult | null = null;
let cursor = 0; // 0 = start position, n = after ply n
let whiteAtBottom = true;

const pieceUrl = (code: string) => chrome.runtime.getURL(`pieces/${code}.svg`);

function setStatus(text: string): void {
  $('status').textContent = text;
}

function showError(text: string | null): void {
  const el = $('error');
  el.classList.toggle('hidden', !text);
  el.textContent = text ?? '';
}

async function run(): Promise<void> {
  const pgn = $<HTMLTextAreaElement>('pgn').value.trim();
  if (!pgn) {
    showError('Paste a PGN first.');
    return;
  }
  showError(null);
  const level = STRENGTH[$<HTMLSelectElement>('strength').value as keyof typeof STRENGTH] ?? STRENGTH.normal;
  const btn = $<HTMLButtonElement>('run');
  btn.disabled = true;
  $('progress').classList.remove('hidden');
  const t0 = Date.now();
  try {
    review = await reviewGame(
      pgn,
      (fen) => engine.evaluate(fen, { depth: level.depth, movetimeMs: level.movetimeMs, multiPv: 2 }),
      (p) => {
        $('progress-bar').style.width = `${Math.round((p.ply / Math.max(1, p.total)) * 100)}%`;
        const elapsed = (Date.now() - t0) / 1000;
        const eta = p.ply > 0 ? Math.round((elapsed / p.ply) * (p.total - p.ply)) : null;
        setStatus(`Analyzing position ${p.ply}/${p.total}${eta !== null ? ` · ~${eta}s left` : ''} · ${engine.name}`);
      },
    );
    setStatus(`Done in ${Math.round((Date.now() - t0) / 1000)}s · ${engine.name} · depth ${level.depth}`);
    cursor = 0;
    renderReport(review);
    renderPosition();
  } catch (err) {
    showError(`Could not review this game: ${String((err as Error)?.message ?? err)}`);
    setStatus('');
  } finally {
    btn.disabled = false;
  }
}

function renderReport(r: ReviewResult): void {
  $('report').classList.remove('hidden');
  $('boardcard').classList.remove('hidden');
  $('acc-w').textContent = `${r.accuracy.w.toFixed(1)}`;
  $('acc-b').textContent = `${r.accuracy.b.toFixed(1)}`;
  $('name-w').textContent = `${r.headers['White'] ?? 'White'}${r.headers['WhiteElo'] ? ` (${r.headers['WhiteElo']})` : ''}`;
  $('name-b').textContent = `${r.headers['Black'] ?? 'Black'}${r.headers['BlackElo'] ? ` (${r.headers['BlackElo']})` : ''}`;
  $('result').textContent = r.result;
  const opening = r.headers['ECOUrl']
    ? decodeURIComponent(r.headers['ECOUrl'].split('/').pop() ?? '').replace(/-/g, ' ')
    : r.headers['Opening'] ?? '';
  const bookPlies = r.moves.filter((m) => m.judgement.cls === 'book').length;
  $('opening').textContent = `${opening ? opening + ' · ' : ''}${bookPlies} book moves · ${r.moves.length} plies`;

  // Counts table
  const order: MoveClass[] = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
  const rows = order
    .map(
      (c) =>
        `<tr><td class="n">${r.counts.w[c]}</td><td class="l"><span class="dot" style="background:${CLASS_COLOR[c]}"></span>${CLASS_LABEL[c]}</td><td class="n">${r.counts.b[c]}</td></tr>`,
    )
    .join('');
  $('counts').innerHTML = rows;

  // Key moments
  const key = $('key');
  key.innerHTML = '';
  if (!r.keyMoments.length) key.innerHTML = '<div class="hint">No big swings: a clean game.</div>';
  for (const m of r.keyMoments) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<span class="cls" style="background:${CLASS_COLOR[m.judgement.cls]}">${CLASS_SYMBOL[m.judgement.cls]} ${CLASS_LABEL[m.judgement.cls]}</span>
      <strong>${m.moveNumber}${m.mover === 'w' ? '.' : '…'} ${escapeHtml(m.san)}</strong>
      <span class="txt">${escapeHtml(m.note)}</span>`;
    div.addEventListener('click', () => {
      cursor = m.ply;
      renderPosition();
    });
    key.appendChild(div);
  }

  // Move list
  const moves = $('moves');
  moves.innerHTML = '';
  for (let i = 0; i < r.moves.length; i += 2) {
    const w = r.moves[i];
    const b = r.moves[i + 1];
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = `${w.moveNumber}.`;
    moves.appendChild(num);
    moves.appendChild(moveCell(w));
    if (b) moves.appendChild(moveCell(b));
    else {
      const empty = document.createElement('div');
      empty.className = 'mv';
      moves.appendChild(empty);
    }
  }
  drawGraph(r);
}

function moveCell(m: ReviewedMove): HTMLElement {
  const div = document.createElement('div');
  div.className = 'mv';
  div.dataset.ply = String(m.ply);
  div.innerHTML = `<span>${escapeHtml(m.san)}</span><span class="sym" style="background:${CLASS_COLOR[m.judgement.cls]}" title="${CLASS_LABEL[m.judgement.cls]}">${CLASS_SYMBOL[m.judgement.cls]}</span>`;
  div.addEventListener('click', () => {
    cursor = m.ply;
    renderPosition();
  });
  return div;
}

function drawGraph(r: ReviewResult): void {
  const canvas = $<HTMLCanvasElement>('graph');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 120;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const n = r.evalSeries.length;
  const xAt = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const yAt = (cp: number) => h - (winPercent(cp) / 100) * h;
  // Fill: white share from the bottom.
  ctx.fillStyle = '#2b2824';
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), yAt(r.evalSeries[i]));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = '#e9e4da';
  ctx.fill();
  // Midline
  ctx.strokeStyle = 'rgba(128,118,108,.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  // Markers for mistakes/blunders
  for (const m of r.moves) {
    const c = m.judgement.cls;
    if (c !== 'blunder' && c !== 'mistake' && c !== 'miss' && c !== 'brilliant' && c !== 'great') continue;
    ctx.fillStyle = CLASS_COLOR[c];
    ctx.beginPath();
    ctx.arc(xAt(m.ply), yAt(r.evalSeries[m.ply]), 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Cursor
  ctx.strokeStyle = '#58b368';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xAt(cursor), 0);
  ctx.lineTo(xAt(cursor), h);
  ctx.stroke();
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    cursor = Math.max(0, Math.min(n - 1, Math.round((x / rect.width) * (n - 1))));
    renderPosition();
  };
}

function renderPosition(): void {
  if (!review) return;
  const r = review;
  const move = cursor > 0 ? r.moves[cursor - 1] : null;
  const fen = move ? move.fenAfter : r.moves[0]?.fenBefore ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const cp = r.evalSeries[cursor];
  const cls = move?.judgement.cls;
  const showBest = move && cls !== 'best' && cls !== 'book' && cls !== 'brilliant' && cls !== 'great' && move.bestMoveUci;
  renderBoard(
    $('board'),
    {
      fen,
      whiteAtBottom,
      lastMove: move ? { from: move.uci.slice(0, 2), to: move.uci.slice(2, 4) } : null,
      // The best alternative is drawn on the position BEFORE the move, so show
      // it as an arrow from that position's squares (same board, piece moved):
      // we draw it only when it differs from the played move.
      arrow: showBest ? { from: move!.bestMoveUci!.slice(0, 2), to: move!.bestMoveUci!.slice(2, 4), color: '#58b368' } : null,
      badge: move ? { square: move.uci.slice(2, 4), text: CLASS_SYMBOL[move.judgement.cls], color: CLASS_COLOR[move.judgement.cls] } : null,
    },
    pieceUrl,
  );
  $('evalfill').style.height = `${winPercent(cp)}%`;
  const note = $('movenote');
  if (!move) {
    note.innerHTML = `<span class="hint">Start position · ${formatCp(cp)}</span>`;
  } else {
    const alt = showBest ? ` Best was <strong>${escapeHtml(move.bestMoveSan ?? '')}</strong>${move.bestLineSan ? ` (${escapeHtml(move.bestLineSan)})` : ''}.` : '';
    note.innerHTML = `<span class="cls" style="background:${CLASS_COLOR[move.judgement.cls]}">${CLASS_SYMBOL[move.judgement.cls]} ${CLASS_LABEL[move.judgement.cls]}</span>
      <span><strong>${move.moveNumber}${move.mover === 'w' ? '.' : '…'} ${escapeHtml(move.san)}</strong> · eval ${move.evalAfterText} · accuracy ${move.judgement.accuracy}%<br><span class="hint">${escapeHtml(move.note)}${alt}</span></span>`;
  }
  for (const el of document.querySelectorAll<HTMLElement>('.moves .mv')) {
    el.classList.toggle('active', el.dataset.ply === String(cursor));
  }
  document.querySelector<HTMLElement>('.moves .mv.active')?.scrollIntoView({ block: 'nearest' });
  drawGraph(r);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

// --- Wiring ------------------------------------------------------------------
$('run').addEventListener('click', run);
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  $<HTMLTextAreaElement>('pgn').value = await f.text();
});
$('nav-start').addEventListener('click', () => { cursor = 0; renderPosition(); });
$('nav-prev').addEventListener('click', () => { cursor = Math.max(0, cursor - 1); renderPosition(); });
$('nav-next').addEventListener('click', () => { if (review) cursor = Math.min(review.moves.length, cursor + 1); renderPosition(); });
$('nav-end').addEventListener('click', () => { if (review) cursor = review.moves.length; renderPosition(); });
$('nav-flip').addEventListener('click', () => { whiteAtBottom = !whiteAtBottom; renderPosition(); });
document.addEventListener('keydown', (e) => {
  if (!review || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') { cursor = Math.max(0, cursor - 1); renderPosition(); }
  else if (e.key === 'ArrowRight') { cursor = Math.min(review.moves.length, cursor + 1); renderPosition(); }
  else if (e.key === 'Home') { cursor = 0; renderPosition(); }
  else if (e.key === 'End') { cursor = review.moves.length; renderPosition(); }
});
// PGN handed over via the URL hash (e.g. from the overlay in the future).
if (location.hash.length > 1) {
  try {
    $<HTMLTextAreaElement>('pgn').value = decodeURIComponent(location.hash.slice(1));
  } catch {
    /* ignore */
  }
}
