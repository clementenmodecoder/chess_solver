/** Real-site smoke test: load the TEST build in headless Chromium, open
 *  chess.com's play-against-the-computer page (a bot game, never a game
 *  against a human), inject the content script the way the toolbar action
 *  would, and check the whole pipeline on a real board: detection,
 *  recognition, FEN, engine. Then play 1.e4 and check that watch mode
 *  follows the move and infers the side to move.
 *
 *  Usage: npm run test:smoke   (needs network access to chess.com)
 *  Screenshots land in dist-test/smoke/. */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
const distTest = process.env.CHESS_LENS_DIST ? resolve(process.env.CHESS_LENS_DIST) : resolve(import.meta.dirname, '../../dist-test');
const out = resolve(distTest, 'smoke');
mkdirSync(out, { recursive: true });
const context = await chromium.launchPersistentContext('', {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
  args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`],
  viewport: { width: 1400, height: 1000 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
sw.on('console', (m) => console.log('[sw]', m.text().slice(0, 300)));
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error' || /chess.?lens/i.test(m.text())) console.log('[page]', m.type(), m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto('https://www.chess.com/play/computer', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
// dismiss cookie / modal if present
for (const sel of ['button:has-text("Accept")', 'button:has-text("Accepter")', '[data-cy="modal-close"]', 'button[aria-label="Close"]', '.ui_outside-close-component']) {
  try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 800 })) { await b.click(); await page.waitForTimeout(500); } } catch {}
}
await page.screenshot({ path: `${out}/computer-before.png` });
console.log('url', page.url());
await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
});
const read = () => page.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.chessLensDebug || 'null'); } catch { return null; } });
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const d = await read();
  if (i % 5 === 0) console.log(i, JSON.stringify(d));
  if (d && (d.engineDone || d.status === 'blocked' || d.status === 'no-board' || d.status === 'invalid' || (d.status==='error'))) { console.log('final', JSON.stringify(d)); break; }
}
await page.screenshot({ path: `${out}/computer-after.png` });

// --- Phase 2: play 1.e4 on the board and check watch mode follows -----------
const d0 = await read();
if (d0?.boardRect && d0.fen?.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR')) {
  const { x, y, w } = d0.boardRect;
  const cell = w / 8;
  const sq = (file, rank) => ({ x: x + (file + 0.5) * cell, y: y + (8 - rank - 0.5) * cell });
  const e2 = sq(4, 1), e4 = sq(4, 3);
  await page.mouse.click(e2.x, e2.y);
  await page.waitForTimeout(300);
  await page.mouse.click(e4.x, e4.y);
  let moved = null;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    const d = await read();
    if (d?.fen && d.fen !== d0.fen) { moved = d; if (d.engineDone) break; }
  }
  console.log('after-move', moved ? JSON.stringify({ fen: moved.fen, status: moved.status, bestMove: moved.bestMove, depth: moved.depth, scanCount: moved.scanCount }) : 'NO CHANGE DETECTED');
  await page.screenshot({ path: `${out}/computer-after-move.png` });
}
await context.close();
