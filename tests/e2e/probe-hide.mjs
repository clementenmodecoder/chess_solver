import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const fixtureDir = resolve(root, 'tests/fixtures');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/fixture/')) {
    try { res.writeHead(200, {'content-type':'image/png'}); res.end(readFileSync(resolve(fixtureDir, url.pathname.slice(9)))); } catch { res.writeHead(404); res.end(); }
    return;
  }
  res.writeHead(200, {'content-type':'text/html'});
  res.end(`<!doctype html><body style="margin:0;background:#f4f1ea"><h3 style="margin:12px">t</h3><div style="padding:24px"><img id="board" src="/fixture/cburnett-start-brown-256.png" width="512" height="512"></div></body>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const context = await chromium.launchPersistentContext('', {
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: [`--disable-extensions-except=${root}/dist-test`, `--load-extension=${root}/dist-test`],
  viewport: { width: 1280, height: 900 },
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const page = await context.newPage();
page.on('console', m => { if (m.text().includes('chess-lens')) console.log(m.text().slice(0,300)); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.bringToFront();
await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
});
await page.waitForFunction(() => (document.documentElement.dataset.chessLensDebug ?? '').includes('"fen":"r'), undefined, { timeout: 30000 });
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('chess-lens-debug', { detail: 'rescan' })));
  await page.waitForTimeout(900);
}
console.log('final:', await page.evaluate(() => document.documentElement.dataset.chessLensDebug));
await context.close(); server.close();
