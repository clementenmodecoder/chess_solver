/** Capture a screenshot of the overlay UI for visual inspection. */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = resolve(root, 'tests/fixtures');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/fixture/')) {
    try { res.writeHead(200, {'content-type':'image/png'}); res.end(readFileSync(resolve(fixtureDir, url.pathname.slice(9)))); } catch { res.writeHead(404); res.end(); }
    return;
  }
  res.writeHead(200, {'content-type':'text/html'});
  res.end(`<!doctype html><body style="margin:0;background:#312e2b">
    <div style="display:flex;justify-content:center;padding:40px">
    <img src="/fixture/${url.searchParams.get('img') ?? 'cburnett-middlegame-green-512-flipped.png'}" width="520" height="520"></div></body>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const context = await chromium.launchPersistentContext('', {
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  headless: true,
  args: [`--disable-extensions-except=${root}/dist-test`, `--load-extension=${root}/dist-test`],
  viewport: { width: 1280, height: 820 },
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);
await page.bringToFront();
await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
});
await page.waitForFunction(() => {
  const raw = document.documentElement.dataset.chessLensDebug;
  return raw && JSON.parse(raw).depth >= 12;
}, undefined, { timeout: 60000 });
await page.waitForTimeout(500);
await page.screenshot({ path: process.argv[2] ?? '/tmp/overlay.png' });
await context.close(); server.close();
console.log('screenshot saved');
