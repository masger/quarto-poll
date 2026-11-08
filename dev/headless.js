#!/usr/bin/env node
/* Minimal headless-browser driver over the Chrome DevTools Protocol (no dependencies).
 * Used for end-to-end tests and screenshots of quarto-poll.
 *
 *   node dev/headless.js <url> [--mobile] [--size WxH] [--wait ms] [--eval "js"] [--shot file.png] ...
 *
 * Steps run in order. Console output and exceptions from the page are printed.
 * Also usable as a module: require('./headless').run(url, steps, options) resolves to the list of eval results. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/hostedtoolcache/chromium/latest/x64/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findBrowser() {
  return CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

function run(url, steps, options = {}) {
  const browser = options.browser || findBrowser();
  if (!browser) return Promise.reject(new Error('No browser found; set BROWSER=/path/to/chrome'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-headless-'));
  const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const log = options.quiet ? () => {} : (...a) => console.log(...a);
  const results = [];

  return new Promise((resolve, reject) => {
    let wsUrl = null;
    const timer = setTimeout(() => finish(new Error('timeout')), options.timeout || 120000);
    function finish(err) {
      clearTimeout(timer);
      try { proc.kill(); } catch (e) { /* ignore */ }
      setTimeout(() => {
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        if (err) reject(err); else resolve(results);
      }, 300);
    }
    proc.on('error', (e) => finish(e));
    proc.stderr.on('data', (d) => {
      const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/);
      if (m && !wsUrl) { wsUrl = m[1]; main().catch(finish); }
    });

    async function main() {
      const ws = new WebSocket(wsUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      let id = 0;
      const pending = new Map();
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        if (m.method === 'Runtime.consoleAPICalled') {
          const text = m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' ');
          if (!/Imprivata/.test(text)) log('[console.' + m.params.type + ']', text);
        } else if (m.method === 'Runtime.exceptionThrown') {
          log('[exception]', m.params.exceptionDetails.text, (m.params.exceptionDetails.exception || {}).description || '');
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
      if (options.pre) await send('Page.addScriptToEvaluateOnNewDocument', { source: options.pre }, sessionId);
      if (options.mobile) {
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
      } else if (options.size) {
        const [w, h] = options.size.split('x').map(Number);
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
      }
      await send('Page.navigate', { url }, sessionId);

      for (const s of steps) {
        if (s.wait) await new Promise((r) => setTimeout(r, Number(s.wait)));
        if (s.eval) {
          const r = await send('Runtime.evaluate', { expression: s.eval, returnByValue: true, awaitPromise: true }, sessionId);
          if (r.result.exceptionDetails) {
            const text = r.result.exceptionDetails.text + ' ' + ((r.result.exceptionDetails.exception || {}).description || '');
            log('[eval error]', text);
            results.push({ error: text });
          } else {
            log('[eval]', JSON.stringify(r.result.result.value));
            results.push({ value: r.result.result.value });
          }
        }
        if (s.shot) {
          const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
          fs.writeFileSync(s.shot, Buffer.from(r.result.data, 'base64'));
          log('[shot]', s.shot);
        }
      }
      await send('Browser.close');
      finish();
    }
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const url = args.shift();
  const steps = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--browser') options.browser = args[++i];
    else if (a === '--mobile') options.mobile = true;
    else if (a === '--size') options.size = args[++i];
    else if (a === '--pre') options.pre = args[++i];
    else if (a === '--wait') steps.push({ wait: args[++i] });
    else if (a === '--eval') steps.push({ eval: args[++i] });
    else if (a === '--shot') steps.push({ shot: args[++i] });
  }
  if (!url) { console.error('usage: headless.js <url> [--mobile] [--size WxH] [--wait ms] [--eval expr] [--shot file.png]'); process.exit(2); }
  run(url, steps, options).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { run, findBrowser };
