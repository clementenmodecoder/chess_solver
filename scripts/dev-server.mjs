/** Tiny version server for dev auto-reload: serves the current dev build id
 *  (from .dev-build-id) with CORS so the extension's service worker can poll
 *  it from any machine. Usage: node scripts/dev-server.mjs [port] */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const port = Number(process.argv[2] ?? 8765);
http
  .createServer((req, res) => {
    console.log(new Date().toISOString(), req.socket.remoteAddress, req.url);
    let id = '';
    try {
      id = readFileSync(resolve(root, '.dev-build-id'), 'utf8').trim();
    } catch {
      /* no dev build yet */
    }
    // Chrome Private Network Access: a Tailscale address counts as private,
    // so the preflight must be answered and allowed explicitly.
    const headers = {
      'content-type': 'text/plain',
      'access-control-allow-origin': '*',
      'access-control-allow-private-network': 'true',
      'access-control-allow-headers': '*',
      'cache-control': 'no-store',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(id);
  })
  .listen(port, '0.0.0.0', () => console.log(`dev version server on :${port}`));
