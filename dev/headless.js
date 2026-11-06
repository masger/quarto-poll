#!/usr/bin/env node
/* Minimal headless-browser driver over the Chrome DevTools Protocol (no dependencies).
 * Used for end-to-end tests of quarto-poll against dev/mock_firebase.py.
 *
 *   node dev/headless.js <url> [--wait ms] [--eval "js expression"] ... [--browser path]
 *
 * Steps run in order. Console output and exceptions from the page are printed. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const url = args.shift();
const steps = [];
let browser = process.env.BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--browser') browser = args[i + 1];
  else steps.push({ op: args[i].slice(2), arg: args[i + 1] });
}
if (!url || !browser) { console.error('usage: headless.js <url> [--wait ms] [--eval expr]'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-headless-'));
const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });

let wsUrl = null;
proc.stderr.on('data', (d) => {
  const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/);
  if (m && !wsUrl) { wsUrl = m[1]; main().catch((e) => { console.error(e); finish(1); }); }
});

function finish(code) {
  try { proc.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ } process.exit(code); }, 300);
}

async function main() {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('[console.' + m.params.type + ']', m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      console.log('[exception]', m.params.exceptionDetails.text, (m.params.exceptionDetails.exception || {}).description || '');
    }
  };
  const send = (method, params, sessionId) => new Promise((res) => {
    const msg = { id: ++id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(msg.id, res);
    ws.send(JSON.stringify(msg));
  });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);

  for (const s of steps) {
    if (s.op === 'wait') await new Promise((r) => setTimeout(r, Number(s.arg)));
    if (s.op === 'eval') {
      const r = await send('Runtime.evaluate', { expression: s.arg, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.result.exceptionDetails) console.log('[eval error]', r.result.exceptionDetails.text, (r.result.exceptionDetails.exception || {}).description || '');
      else console.log('[eval]', JSON.stringify(r.result.result.value));
    }
  }
  await send('Browser.close');
  finish(0);
}
setTimeout(() => { console.error('timeout'); finish(3); }, 120000);
