// Capture desktop + mobile screenshots of the demo (design QA, no dependency).
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || path.join(ROOT, 'test', 'shots');
const SERVER_PORT = 8094;
const CDP_PORT = 9334;
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
  const file = rel === '' ? path.join(ROOT, 'index.html') : path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-shot-'));
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', `http://127.0.0.1:${SERVER_PORT}/`
], { stdio: 'ignore', windowsHide: true });

let ws;
try {
  const page = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
        const p = list.find(t => t.type === 'page' && (t.url || '').includes(`127.0.0.1:${SERVER_PORT}`));
        if (p) return p;
      } catch (e) {}
      await delay(250);
    }
    throw new Error('no page target');
  })();

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
  };
  const call = (method, params = {}) => new Promise(resolve => {
    const i = ++id; pending.set(i, { resolve });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await call('Page.enable');
  await call('Runtime.enable');
  for (let i = 0; i < 40; i++) {
    const r = await call('Runtime.evaluate', { expression: "document.body && document.body.dataset && document.body.dataset.appReady === 'true' && document.querySelectorAll('.day').length === 7", returnByValue: true });
    if (r.result && r.result.value === true) break;
    await delay(200);
  }

  const shot = async (name, opts) => {
    if (opts) await call('Emulation.setDeviceMetricsOverride', opts);
    await delay(400);
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    console.log('WROTE ' + path.join(OUT, name));
  };

  // Desktop full page
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await shot('desktop-hero.png');
  await call('Runtime.evaluate', { expression: "document.querySelector('[data-day=\"wed\"] [data-action=\"miss\"]').click()", returnByValue: true });
  await delay(120);
  await shot('desktop-adapted.png');

  // Mobile
  await shot('mobile-top.png', { width: 375, height: 720, deviceScaleFactor: 2, mobile: true });

  await call('Emulation.clearDeviceMetricsOverride');
} catch (err) {
  console.error('ERROR ' + err.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { edge.kill(); } catch (e) {}
  await delay(300);
  try { server.close(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); } catch (e) { /* best effort */ }
}