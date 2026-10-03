/** End-to-end test: load the (test) extension build in Chromium, open a page
 *  showing a rendered chessboard fixture, inject the content script the way
 *  the toolbar action would, and assert that the full pipeline works:
 *  capture -> detection -> recognition -> FEN -> Stockfish analysis.
 *
 *  Usage: node tests/e2e/run-e2e.mjs   (requires `node scripts/build.mjs --test`)
 */

import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const distTest = resolve(root, 'dist-test');
const fixtureDir = resolve(root, 'tests/fixtures');

if (!existsSync(resolve(distTest, 'manifest.json'))) {
  console.error('dist-test missing — run: node scripts/build.mjs --test');
  process.exit(1);
}
if (!existsSync(resolve(fixtureDir, 'index.json'))) {
  console.error('fixtures missing — run: npm run gen:fixtures');
  process.exit(1);
}

const fixtures = JSON.parse(readFileSync(resolve(fixtureDir, 'index.json'), 'utf8'));

// Extra fixture for the watch/side-inference scenario: the start position
// after 1.e4, same set/theme/size as cburnett-start-brown-256.
{
  const { renderBoard } = await import('../../scripts/lib/boardgen.mjs');
  const { writePng } = await import('../../scripts/lib/util.mjs');
  const { img } = renderBoard({
    placement: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR',
    set: 'cburnett', theme: 'brown', boardSize: 256, whiteAtBottom: true,
  });
  writePng(resolve(fixtureDir, 'e2e-after-e4.png'), img);
}

// --- Tiny static server for the test pages ----------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/fixture/')) {
    const name = url.pathname.slice('/fixture/'.length);
    try {
      const png = readFileSync(resolve(fixtureDir, name));
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  if (url.pathname === '/board') {
    const img = url.searchParams.get('img');
    const size = url.searchParams.get('size') ?? '480';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Test board</title></head>
      <body style="margin:0;background:#f4f1ea;font-family:sans-serif">
      <h3 style="margin:12px">Chess Lens E2E fixture</h3>
      <div style="padding:24px">
        <img id="board" src="/fixture/${img}" width="${size}" height="${size}" style="display:block">
      </div></body></html>`);
    return;
  }
  if (url.pathname === '/clocks') {
    // Live-game lookalike: two ticking clocks.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body style="margin:0">
      <div id="c1" style="font-size:24px">05:00</div>
      <img src="/fixture/cburnett-start-brown-256.png" width="256" height="256">
      <div id="c2" style="font-size:24px">04:30</div>
      <script>
        let t1 = 300, t2 = 270;
        const f = (t) => String(Math.floor(t/60)).padStart(2,'0') + ':' + String(Math.floor(t%60)).padStart(2,'0');
        setInterval(() => { t1 -= 1; document.getElementById('c1').textContent = f(t1); }, 1000);
      </script></body></html>`);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// --- Browser with extension ---------------------------------------------------
const context = await chromium.launchPersistentContext('', {
  executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
  headless: true,
  args: [
    `--disable-extensions-except=${distTest}`,
    `--load-extension=${distTest}`,
  ],
  viewport: { width: 1280, height: 900 },
});

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });

  async function inject(page) {
    // Simulate the toolbar action: the SW injects content.js into the tab.
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
    });
  }

  const readDebug = (page) =>
    page.evaluate(() => {
      const raw = document.documentElement.dataset.chessLensDebug;
      return raw ? JSON.parse(raw) : null;
    });

  async function waitDebug(page, predSrc, timeoutMs) {
    // predSrc: a function taking the parsed debug object.
    return page.waitForFunction(
      (predStr) => {
        const raw = document.documentElement.dataset.chessLensDebug;
        const dbg = raw ? JSON.parse(raw) : null;
        // eslint-disable-next-line no-new-func
        return new Function('dbg', `return (${predStr})(dbg)`)(dbg);
      },
      predSrc.toString(),
      { timeout: timeoutMs, polling: 250 },
    );
  }

  // ---- Scenario 1: start position, engine analysis end-to-end ---------------
  {
    const page = await context.newPage();
    await page.goto(`${base}/board?img=cburnett-start-brown-256.png&size=512`);
    await page.bringToFront();
    await inject(page);
    await waitDebug(page, (dbg) => dbg?.fen != null, 30000);
    const fen = (await readDebug(page)).fen;
    check(
      fen === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      `start position FEN recognized in-browser (got: ${fen})`,
    );
    await waitDebug(page, (dbg) => (dbg?.depth ?? 0) >= 12, 60000);
    const dbg = await readDebug(page);
    check(dbg.depth >= 12, `engine reached depth ${dbg.depth}`);
    check(/^[+-]?\d|^-?M/.test(dbg.scoreText), `score displayed (${dbg.scoreText})`);
    check(!!dbg.bestMove, `best move displayed (${dbg.bestMove})`);
    check(await page.evaluate(() => !!document.getElementById('chess-lens-host')), 'overlay mounted');
    check(dbg.recognizer === 'cnn', `CNN recognizer used (${dbg.recognizer})`);
    await page.close();
  }

  // ---- Scenario 1b: textured wood board with coordinate glyphs ---------------
  {
    const page = await context.newPage();
    await page.goto(`${base}/board?img=special-wood-coords-large.png&size=700`);
    await page.bringToFront();
    await inject(page);
    await waitDebug(page, (dbg) => dbg?.fen != null, 30000);
    const dbg = await readDebug(page);
    check(
      dbg.fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'),
      `wood-textured board recognized (got: ${dbg.fen})`,
    );
    await page.close();
  }

  // ---- Scenario 2: flipped middlegame, orientation + position ----------------
  {
    const page = await context.newPage();
    await page.goto(`${base}/board?img=merida-middlegame-green-600-flipped.png&size=600`);
    await page.bringToFront();
    await inject(page);
    await waitDebug(page, (dbg) => dbg?.fen != null, 30000);
    const dbg = await readDebug(page);
    check(
      dbg.fen.startsWith('r1bq1rk1/pp2ppbp/2np1np1/8/2PNP3/2N1B3/PP2BPPP/R2Q1RK1'),
      `flipped middlegame recognized (got: ${dbg.fen})`,
    );
    check(dbg.whiteAtBottom === false, 'orientation detected as black-at-bottom');
    await page.close();
  }

  // ---- Scenario 3: toolbar toggle cycle (on -> off -> on) --------------------
  {
    const page = await context.newPage();
    await page.goto(`${base}/board?img=cburnett-start-brown-256.png&size=480`);
    await page.bringToFront();
    await inject(page);
    await waitDebug(page, (dbg) => dbg?.fen != null, 30000);
    const toggle = () =>
      sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        await chrome.tabs.sendMessage(tabs[0].id, { type: 'toggle-overlay' });
      });
    await toggle();
    await page.waitForFunction(() => !document.getElementById('chess-lens-host'), undefined, { timeout: 5000 });
    check(true, 'toggle off removes overlay');
    await toggle();
    await page.waitForFunction(() => !!document.getElementById('chess-lens-host'), undefined, { timeout: 5000 });
    await waitDebug(page, (dbg) => dbg?.fen != null && dbg.status === 'analyzing', 30000);
    check(true, 'toggle on again re-scans and re-analyzes');
    await page.close();
  }

  // ---- Scenario 3b: automatic rescans do not flicker the overlay -------------
  {
    const page = await context.newPage();
    await page.goto(`${base}/board?img=cburnett-start-brown-256.png&size=512`);
    await page.bringToFront();
    await inject(page);
    await waitDebug(page, (dbg) => dbg?.fen != null, 30000);
    const before = await readDebug(page);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('chess-lens-debug', { detail: 'rescan' })));
      await page.waitForTimeout(900);
    }
    const after = await readDebug(page);
    check(after.scanCount > before.scanCount, `rescans ran (${before.scanCount} -> ${after.scanCount})`);
    check(
      (after.hideCount ?? 0) <= (before.hideCount ?? 0),
      `overlay never hidden during rescans (hides ${before.hideCount} -> ${after.hideCount})`,
    );
    check(
      after.error == null && after.status !== 'invalid',
      `rescans stay clean - no arrow contamination (status ${after.status}, error ${after.error})`,
    );
    check(
      after.fen === before.fen,
      'position unchanged across rescans',
    );
    await page.close();
  }

  // ---- Scenario 3d: watch mode follows a move and infers side to move --------
  {
    const page = await context.newPage();
    await page.goto(`${base}/board?img=cburnett-start-brown-256.png&size=512`);
    await page.bringToFront();
    await inject(page);
    await waitDebug(page, (dbg) => dbg?.fen != null, 30000);
    const before = await readDebug(page);
    check(before.fen.includes(' w '), `initial position is white to move (${before.fen})`);
    // The page plays 1.e4: swap the board image; the MutationObserver on the
    // <img> must trigger a rescan, and the one-legal-move transition must
    // flip the side to move to black.
    await page.evaluate(() => {
      document.getElementById('board').src = '/fixture/e2e-after-e4.png';
    });
    await waitDebug(page, (dbg) => dbg?.fen?.includes('4P3') ?? false, 20000);
    const after = await readDebug(page);
    check(after.fen.includes('4P3'), `watch mode picked up the played move (${after.fen})`);
    check(after.fen.includes(' b '), `side to move inferred as black (${after.fen})`);
    await page.close();
  }

  // ---- Scenario 3c: manual region selection ----------------------------------
  {
    const page = await context.newPage();
    // Board drawn at a known position: margin 24 + centered layout from /board page.
    await page.goto(`${base}/board?img=merida-middlegame-green-600-flipped.png&size=480`);
    await page.bringToFront();
    await inject(page);
    await waitDebug(page, (dbg) => dbg?.fen != null, 30000);

    // Locate the rendered <img> so the drag brackets the real board.
    const box = await page.locator('#board').boundingBox();
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('chess-lens-debug', { detail: 'select-region' })));
    await page.waitForTimeout(300);
    await page.mouse.move(box.x - 6, box.y - 6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 6, box.y + box.height + 6, { steps: 8 });
    await page.mouse.up();
    await waitDebug(page, (dbg) => dbg?.fen != null && dbg.status === 'analyzing', 30000);
    const dbg = await readDebug(page);
    check(
      dbg.fen.startsWith('r1bq1rk1/pp2ppbp/2np1np1'),
      `manual selection recognized the board (got: ${dbg.fen})`,
    );

    // Cancel path: opening the selector and just clicking must leave the page usable.
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('chess-lens-debug', { detail: 'select-region' })));
    await page.waitForTimeout(200);
    await page.mouse.click(30, 30);
    await page.waitForTimeout(300);
    const clickable = await page.evaluate(() => {
      let got = false;
      const h = () => (got = true);
      document.body.addEventListener('click', h, { once: true });
      document.body.click();
      document.body.removeEventListener('click', h);
      return got;
    });
    check(clickable, 'page stays clickable after cancelled selection');
    await page.close();
  }

  // ---- Scenario 4: live-game lookalike is blocked ----------------------------
  {
    const page = await context.newPage();
    await page.goto(`${base}/clocks`);
    await page.bringToFront();
    await inject(page);
    await waitDebug(page, (dbg) => dbg && dbg.status !== 'boot' && dbg.status !== 'detecting', 30000);
    const dbg = await readDebug(page);
    check(dbg.status === 'blocked', `running clocks block analysis (status: ${dbg.status})`);
    check(dbg.fen === null, 'no FEN produced on blocked page');
    await page.close();
  }
} catch (err) {
  console.error('E2E error:', err);
  failures++;
} finally {
  await context.close();
  server.close();
}

console.log(failures === 0 ? '\nE2E: all scenarios passed' : `\nE2E: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
