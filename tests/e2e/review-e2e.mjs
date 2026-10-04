/** E2E for the Game Review page: open review.html from the test build,
 *  paste a real PGN, run the fast review with the real Stockfish, and check
 *  the report. Usage: node tests/e2e/review-e2e.mjs (after build --test) */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
const distTest = resolve(import.meta.dirname, '../../dist-test');
const out = resolve(distTest, 'smoke');
mkdirSync(out, { recursive: true });
const PGN = `[Event "Play vs Bot"]
[White "YourKnightMare69"]
[Black "Wendy-BOT"]
[Result "0-1"]
[WhiteElo "1534"]
[BlackElo "1500"]
[ECOUrl "https://www.chess.com/openings/Queens-Gambit-Declined"]

1. d4 d5 2. c4 e6 3. Bh6 Nxh6 4. e3 Nd7 5. Nc3 Bb4 6. Nf3 dxc4 7. Bxc4 Bxc3+ 8. bxc3 Nb6 9. Bd3 Qd7 10. O-O Na4 11. Ne5 Qe7 12. Qxa4+ c6 13. Nxc6 Qd7 14. Bb5 a6 15. Bxa6 bxc6 16. Bxc8 Rxc8 17. Rfb1 c5 18. Qd1 cxd4 19. cxd4 O-O 20. a4 Qc6 21. a5 f6 22. Rb6 Qe4 23. a6 e5 24. Qb3+ Kh8 25. d5 Rfd8 26. a7 Nf5 27. Rb4 Qxd5 28. Qxd5 Rxd5 29. h3 Rdd8 30. Rb8 Rxb8 31. axb8=Q Rxb8 32. Kh2 Nd6 33. Rh1 Nc4 34. Kg1 Rb4 35. Rh2 Rb1# 0-1`;
const ctx = await chromium.launchPersistentContext('', { headless: true, executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(), args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`], viewport: { width: 1300, height: 1000 } });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)); });
await page.goto(`chrome-extension://${extId}/review.html`);
await page.fill('#pgn', PGN);
await page.selectOption('#strength', 'fast');
const t0 = Date.now();
await page.click('#run');
await page.waitForFunction(() => !document.getElementById('report').classList.contains('hidden'), null, { timeout: 180000 });
const secs = Math.round((Date.now() - t0) / 1000);
const report = await page.evaluate(() => ({
  accW: document.getElementById('acc-w').textContent, accB: document.getElementById('acc-b').textContent,
  status: document.getElementById('status').textContent, key: [...document.querySelectorAll('#key .item')].map((e) => e.textContent.trim().replace(/\s+/g, ' ')).slice(0, 6),
  counts: document.getElementById('counts').innerText.replace(/\n/g, ' | '),
}));
console.log(`review took ${secs}s`, JSON.stringify(report, null, 1));
// Navigate to 3.Bh6 (ply 5) and screenshot
await page.evaluate(() => document.querySelector('.moves .mv[data-ply="5"]').click());
await page.waitForTimeout(300);
const note = await page.evaluate(() => document.getElementById('movenote').innerText);
console.log('note at 3.Bh6:', note.replace(/\n/g, ' '));
await page.screenshot({ path: `${out}/review.png`, fullPage: true });
const ok = /Blunder|Mistake/.test(note) && report.key.length > 0;
console.log(ok ? 'REVIEW E2E: PASS' : 'REVIEW E2E: FAIL');
await ctx.close();
