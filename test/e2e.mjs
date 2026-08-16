// E2E harness: launches headless Edge, serves the demo over HTTP, drives the
// real DOM via the Chrome DevTools Protocol and asserts on the interaction.
// Zero external dependencies (Node >= 22 global WebSocket + fetch).
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PORT = 8093;
const CDP_PORT = 9333;
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// --- static file server ------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));

// --- headless Edge -----------------------------------------------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-edge-'));
const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  `http://127.0.0.1:${SERVER_PORT}/`
], { stdio: 'ignore', windowsHide: true });

let ws;
try {
  // Wait for the CDP endpoint to come up.
  let targetInfo = null;
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find(t => t.type === 'page' && (t.url || '').includes(`127.0.0.1:${SERVER_PORT}`));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      }
      if (page) targetInfo = page;
    } catch (e) { /* not up yet */ }
    if (!ws) await delay(300);
  }
  if (!ws) throw new Error('Could not connect to headless browser CDP');

  let msgId = 0;
  const pending = new Map();
  const consoleLog = [];
  const exceptions = [];

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) resolve({ error: msg.error });
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      consoleLog.push({ type: msg.params.type, text });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params.exceptionDetails.text + ' ' + JSON.stringify(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
    if (msg.method === 'Log.entryAdded') {
      const l = msg.params.entry;
      if (l.level === 'error' || l.level === 'warning') consoleLog.push({ type: l.source + ':' + l.level, text: l.text });
    }
  };

  const call = (method, params = {}) =>
    new Promise(resolve => {
      const id = ++msgId;
      pending.set(id, { resolve, method });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async expr => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.error) return { __error: JSON.stringify(r.error) };
    if (r.exceptionDetails) {
      return {
        __error: r.exceptionDetails.text,
        __detail: (r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value)) || r.exceptionDetails.exception?.description,
        __stack: r.exceptionDetails.stackTrace || null
      };
    }
    return r.result.value;
  };

  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');

  // Wait for the app to actually boot before probing.
  let readyProbe = null;
  for (let i = 0; i < 40; i++) {
    readyProbe = await evaluate(`({ ready: document.body && document.body.dataset && document.body.dataset.appReady === 'true', dayCount: document.querySelectorAll('.day').length })`);
    if (readyProbe && readyProbe.ready && readyProbe.dayCount === 7) break;
    await delay(200);
  }
  check('app boots and renders 7 days (waited)', readyProbe && readyProbe.ready && readyProbe.dayCount === 7, JSON.stringify(readyProbe));

  // --- assertions -------------------------------------------------------
  const initial = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.day')];
    return {
      appReady: document.body.dataset.appReady,
      runtimeError: document.body.dataset.runtimeError || null,
      dayCount: cards.length,
      wed: cards.find(c => c.dataset.day === 'wed')?.querySelector('.day__title')?.textContent,
      fri: cards.find(c => c.dataset.day === 'fri')?.querySelector('.day__title')?.textContent,
      tue: cards.find(c => c.dataset.day === 'tue')?.querySelector('.day__title')?.textContent,
      stats: document.getElementById('week-stats').textContent.replace(/\\s+/g, ' ').trim(),
      title: document.getElementById('adapt-title').textContent
    };
  })()`);
  check('app initialized without runtime error', initial.appReady === 'true' && !initial.runtimeError, JSON.stringify(initial));
  check('renders 7 day cards', initial.dayCount === 7, 'got ' + initial.dayCount);
  check('plan shows the expected week', initial.wed === 'Tempo Intervals' && initial.fri === 'Rest' && initial.tue === 'Easy Run',
    JSON.stringify({ wed: initial.wed, fri: initial.fri, tue: initial.tue }));
  check('initial stats show planned volume 270', /270/.test(initial.stats), initial.stats);
  check('panel shows default hint', initial.title === 'Try it', initial.title);

  // 0) Performance curve + interval strips render on load.
  const trend = await evaluate(`(() => {
    const planned = document.getElementById('trend-planned');
    const adapted = document.getElementById('trend-adapted');
    return {
      plannedPath: (planned.getAttribute('d') || '') === '' ? false : planned.getAttribute('d').startsWith('M'),
      adaptedPath: adapted.getAttribute('d'),
      adaptedHidden: document.getElementById('trend-legend-adapted').classList.contains('is-hidden'),
      readout: document.getElementById('trend-readout').textContent.replace(/\\s+/g, ' ').trim(),
      wedBars: document.querySelectorAll('[data-day="wed"] .day__steps i').length,
      friBars: document.querySelectorAll('[data-day="fri"] .day__steps i').length
    };
  })()`);
  check('performance curve renders a projected form path', trend.plannedPath === true, trend.plannedPath);
  check('adapted curve hidden until a session is missed', trend.adaptedPath === '' && trend.adaptedHidden === true,
    JSON.stringify({ path: trend.adaptedPath, hidden: trend.adaptedHidden }));
  check('readout shows form/fatigue projection', /Form/.test(trend.readout) && /Fatigue/.test(trend.readout), trend.readout);
  check('key sessions render interval strips, rest days do not', trend.wedBars >= 4 && trend.friBars === 0,
    'wed=' + trend.wedBars + ' fri=' + trend.friBars);

  // 1) Miss Wed (key session) -> moves to Fri (rest), explanation panel updates.
  const missWed = await evaluate(`(() => {
    document.querySelector('[data-day="wed"] [data-action="miss"]').click();
    const wed = document.querySelector('[data-day="wed"]');
    const fri = document.querySelector('[data-day="fri"]');
    return {
      wedMissed: wed.classList.contains('day--missed'),
      wedTitle: wed.querySelector('.day__title').textContent,
      wedChips: [...wed.querySelectorAll('.chip')].map(c => c.textContent),
      friTitle: fri.querySelector('.day__title').textContent,
      friRescheduled: fri.classList.contains('day--rescheduled'),
      friChips: [...fri.querySelectorAll('.chip')].map(c => c.textContent),
      title: document.getElementById('adapt-title').textContent,
      notes: [...document.querySelectorAll('#adapt-list li')].map(li => li.textContent),
      foot: document.getElementById('adapt-stats').textContent,
      stats: document.getElementById('week-stats').textContent.replace(/\\s+/g, ' ').trim()
    };
  })()`);
  check('Wed becomes missed/rest with explanation chips', missWed.wedMissed && missWed.wedTitle === 'Rest' &&
    missWed.wedChips.includes('Missed') && missWed.wedChips.some(c => c.startsWith('Moved to')), JSON.stringify(missWed.wedChips));
  check('Tempo rescheduled onto Fri and highlighted', missWed.friTitle === 'Tempo Intervals' && missWed.friRescheduled && missWed.friChips.includes('Rescheduled'),
    missWed.friTitle);

  const arrow = await evaluate(`({
    active: document.getElementById('reshuffle-arrow').classList.contains('is-active'),
    path: !!document.querySelector('#reshuffle-arrow path'),
    head: !!document.querySelector('#reshuffle-arrow .reshuffle-head')
  })`);
  check('reshuffle arrow draws the move Wed→Fri', arrow.active && arrow.path && arrow.head, JSON.stringify(arrow));
  check('panel explains the change', missWed.title === 'Your plan just adapted' && missWed.notes.length >= 3 &&
    missWed.notes.some(n => n.includes('Fri')) && /reshuffled/.test(missWed.foot), JSON.stringify(missWed.notes));
  check('volume preserved for a rest-swap', /270/.test(missWed.stats) && missWed.stats.includes('0'), missWed.stats);

  const missTrend = await evaluate(`(() => {
    const adapted = document.getElementById('trend-adapted');
    return {
      adaptedPath: adapted.getAttribute('d') || '',
      legendText: document.getElementById('trend-legend-adapted').textContent,
      legendVisible: !document.getElementById('trend-legend-adapted').classList.contains('is-hidden'),
      readout: document.getElementById('trend-readout').textContent.replace(/\\s+/g, ' ').trim()
    };
  })()`);
  check('missed session triggers the live-rebalanced curve', missTrend.adaptedPath !== '' && missTrend.legendVisible &&
    missTrend.legendText.includes('Wed') && missTrend.readout.includes('live-rebalanced'), JSON.stringify(missTrend));

  // 2) Miss Sun (key, last day) -> rolls to next week.
  const missSun = await evaluate(`(() => {
    document.querySelector('[data-day="sun"] [data-action="miss"]').click();
    const sun = document.querySelector('[data-day="sun"]');
    const fri = document.querySelector('[data-day="fri"]');
    return {
      sunMissed: sun.classList.contains('day--missed'),
      sunTitle: sun.querySelector('.day__title').textContent,
      sunChips: [...sun.querySelectorAll('.chip')].map(c => c.textContent),
      friTitle: fri.querySelector('.day__title').textContent,
      wedTitle: document.querySelector('[data-day="wed"] .day__title').textContent,
      notes: [...document.querySelectorAll('#adapt-list li')].map(li => li.textContent),
      stats: document.getElementById('week-stats').textContent.replace(/\\s+/g, ' ').trim()
    };
  })()`);
  check('Sun long run rolls to next week (no slot)', missSun.sunMissed && missSun.sunTitle === 'Rest' &&
    missSun.sunChips.some(c => c.includes('next week')) && missSun.notes.some(n => n.includes('next week')), JSON.stringify(missSun.sunChips));
  check('previous reschedule reverted, week back to baseline', missSun.friTitle === 'Rest' && missSun.wedTitle === 'Tempo Intervals',
    missSun.friTitle + ' / ' + missSun.wedTitle);
  check('volume drops for the rolled session', missSun.stats.includes('180'), missSun.stats);

  // 3) Miss Tue (easy) -> dropped, extra rest.
  const missTue = await evaluate(`(() => {
    document.querySelector('[data-day="tue"] [data-action="miss"]').click();
    const tue = document.querySelector('[data-day="tue"]');
    return {
      tueMissed: tue.classList.contains('day--missed'),
      tueTitle: tue.querySelector('.day__title').textContent,
      tueChips: [...tue.querySelectorAll('.chip')].map(c => c.textContent),
      notes: [...document.querySelectorAll('#adapt-list li')].map(li => li.textContent),
      stats: document.getElementById('week-stats').textContent.replace(/\\s+/g, ' ').trim()
    };
  })()`);
  check('easy run dropped and day becomes rest', missTue.tueMissed && missTue.tueTitle === 'Rest' &&
    missTue.tueChips.includes('Easy run dropped'), JSON.stringify(missTue.tueChips));
  check('volume falls by 40 min', missTue.stats.includes('230') && missTue.stats.includes('40'), missTue.stats);

  // 4) Restore via the same card's button.
  const restored = await evaluate(`(() => {
    document.querySelector('[data-day="tue"] [data-action="restore"]').click();
    const tue = document.querySelector('[data-day="tue"]');
    return {
      tueTitle: tue.querySelector('.day__title').textContent,
      stats: document.getElementById('week-stats').textContent.replace(/\\s+/g, ' ').trim(),
      title: document.getElementById('adapt-title').textContent,
      rescheduledCount: document.querySelectorAll('.day--rescheduled').length
    };
  })()`);
  check('restore returns the plan to baseline', restored.tueTitle === 'Easy Run' && rebuiltStatsRestored(restored.stats) &&
    restored.title === 'Try it' && restored.rescheduledCount === 0, JSON.stringify(restored));

  const arrowHidden = await evaluate(`(!document.getElementById('reshuffle-arrow').classList.contains('is-active'))`);
  check('reshuffle arrow hidden after restore', arrowHidden === true, '' + arrowHidden);

  // 5) Reset button.
  const reset = await evaluate(`(() => {
    document.querySelector('[data-day="sat"] [data-action="miss"]').click();
    document.getElementById('btn-reset').click();
    const sat = document.querySelector('[data-day="sat"]');
    return {
      satTitle: sat.querySelector('.day__title').textContent,
      title: document.getElementById('adapt-title').textContent
    };
  })()`);
  check('reset button clears the missed state', reset.satTitle === 'Easy Run' && reset.title === 'Try it', JSON.stringify(reset));

  // 6b) Visual smoke: theme applied, fonts declared, text/contrast sane (no white-on-white).
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(250);
  const vis = await evaluate(`(() => {
    const headline = getComputedStyle(document.querySelector('.hero__headline'));
    const meta = getComputedStyle(document.querySelector('.day__meta'));
    const day = getComputedStyle(document.querySelector('[data-day="wed"]'));
    const title = getComputedStyle(document.querySelector('[data-day="wed"] .day__title'));
    const sub = getComputedStyle(document.querySelector('.hero__sub'));
    return {
      dosisDeclared: headline.fontFamily.includes('Dosis'),
      encodeDeclared: getComputedStyle(document.body).fontFamily.indexOf('Encode Sans Condensed') !== -1,
      monoDeclared: meta.fontFamily.includes('JetBrains Mono'),
      fontsStatus: document.fonts.status,
      fontsReadyOk: false,
      dayBg: day.backgroundColor,
      dayColor: title.color,
      subColor: sub.color,
      weekW: Math.round(document.getElementById('plan-week').getBoundingClientRect().width),
      coachPos: getComputedStyle(document.querySelector('.panel--coach')).position,
      qty: document.querySelectorAll('.day').length
    };
  })()`);
  const lum = rgbaStr => {
    const m = rgbaStr.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const ch = m[1].split(',').map(x => parseFloat(x.trim()));
    const a = ch.length === 4 ? ch[3] : 1;
    const r = ch[0] * a + 4 * (1 - a);   // over near-black shell
    const g = ch[1] * a + 8 * (1 - a);
    const b = ch[2] * a + 10 * (1 - a);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const dayLum = lum(vis.dayBg);
  const dayTextLum = lum(vis.dayColor);
  check('Dosis / Encode / JetBrains Mono declared in stylesheet',
    vis.dosisDeclared && vis.encodeDeclared && vis.monoDeclared, JSON.stringify({ dosis: vis.dosisDeclared, encode: vis.encodeDeclared, mono: vis.monoDeclared }));
  check('dark telemetry theme applied (workout card is dark)', dayLum !== null && dayLum < 90, vis.dayBg + ' lum=' + dayLum);
  check('light text on dark cards (contrast ratio sane)',
    dayTextLum !== null && dayTextLum > 160, vis.dayColor);
  check('7 day cards render with real width', vis.qty === 7 && vis.weekW > 600, 'weekW=' + vis.weekW);
  check('coach panel is sticky on desktop viewport', vis.coachPos === 'sticky', vis.coachPos);
  if (vis.fontsStatus && vis.fontsStatus !== 'loaded') console.log('      note: webfonts status=' + vis.fontsStatus + ' (offline headless env)');
  await call('Emulation.clearDeviceMetricsOverride');

  // 6) Browser console: no page exceptions / hard errors.
  const jsErrors = consoleLog.filter(l => l.type === 'error' || l.type === 'exception' || l.type.includes('javascript:error'));
  const netErrors = consoleLog.filter(l => l.type.includes('network'));
  check('no uncaught page exceptions', exceptions.length === 0, JSON.stringify(exceptions));
  check('no console.error reported', jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)));
  check('no failed local network requests',
    netErrors.length === 0 || netErrors.every(e => /fonts\.googleapis|fonts\.gstatic|favicon/i.test(e.text)),
    netErrors.length ? netErrors.slice(0, 3).map(e => e.text).join(' | ') : 'none');

  // 7) Mobile viewport: layout collapses and the interaction still works.
  await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 720, deviceScaleFactor: 2, mobile: true });
  let mobReady = false;
  for (let i = 0; i < 40; i++) {
    const r = await evaluate(`(document.querySelectorAll('.day').length === 7 && document.title.indexOf('Demo') !== -1)`);
    if (r === true) { mobReady = true; break; }
    await delay(200);
  }
  check('mobile viewport ready after emulation', mobReady === true, mobReady);
  const mobile = await evaluate(`(() => {
    try {
      const week = document.getElementById('plan-week');
      const cols = getComputedStyle(week).gridTemplateColumns.split(' ').length;
      const demoCols = getComputedStyle(document.querySelector('.demo__grid')).gridTemplateColumns.split(' ').length;
      document.querySelector('[data-day="sat"] [data-action="miss"]').click();
      return {
        cols, demoCols,
        satTitle: document.querySelector('[data-day="sat"] .day__title').textContent,
        title: document.getElementById('adapt-title').textContent,
        bodyScale: (document.body.scrollWidth <= window.innerWidth + 1)
      };
    } catch (e) {
      return { err: String(e && e.stack || e) };
    }
  })()`);
  if (mobile.err) console.log('  [debug] mobile evaluate threw:', mobile.err);
  check('mobile viewport uses stacked week (2-col) and single demo column', mobile.cols === 2 && mobile.demoCols === 1,
    JSON.stringify({ cols: mobile.cols, demoCols: mobile.demoCols }));
  check('no horizontal overflow on mobile', mobile.bodyScale === true, 'scrollWidth=' + mobile.cols);
  check('interaction works on mobile viewport', mobile.satTitle === 'Rest' && mobile.title === 'Your plan just adapted',
    mobile.satTitle + ' / ' + mobile.title);
  await call('Emulation.clearDeviceMetricsOverride');
} catch (err) {
  console.log('  FAIL  harness error: ' + err.stack);
  results.push({ name: 'harness', ok: false, detail: err.message });
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { edge.kill(); } catch (e) {}
  await delay(300);
  try { server.close(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); } catch (e) { /* best effort */ }
}

function rebuiltStatsRestored(statsText) {
  return /270/.test(statsText) && statsText.includes('planned volume');
}

const failed = results.filter(r => !r.ok);
console.log('\n' + results.length + ' checks, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);