#!/usr/bin/env node
/* End-to-end tests for quarto-poll: starts the mock database, renders example.qmd and drives the
 * deck and the audience page in a headless browser. Exit code 1 on any failure.
 *
 *   node dev/test.js            (needs quarto, python and Edge/Chrome; set BROWSER=/path/to/chrome if needed)
 *   node dev/test.js --no-render   (reuse an existing example.html) */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { run } = require('./headless');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8788; // example.qmd points at this port
const DB = `http://localhost:${PORT}`;          // used inside the browser
const NODE_DB = `http://127.0.0.1:${PORT}`;    // Node's fetch prefers IPv6 for localhost; the mock listens on IPv4
const DECK = `${DB}/example.html`;
const AUD = `${DB}/audience/?r=test&db=${encodeURIComponent(DB)}`;
const SLIDE = { clopidogrel: 1, ord: 2, results: 3, skjult: 4, aabent: 5, quiz1: 6, scores: 7, multi1: 8, skala: 9, raekke: 10, tekstquiz: 11, hurtig: 12 };
let failures = 0;

function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${typeof expected === 'function' ? 'predicate' : JSON.stringify(expected)}`}`);
  if (!ok) failures++;
}
const v = (r, i) => (r[i] && 'value' in r[i]) ? r[i].value : r[i];
const put = (p, body) => `fetch('${DB}/pub/test${p}.json',{method:'PUT',body:${JSON.stringify(JSON.stringify(body))}}).then(r=>r.status)`;
const patch = (p, body) => `fetch('${DB}/pub/test${p}.json',{method:'PATCH',body:${JSON.stringify(JSON.stringify(body))}}).then(r=>r.status)`;
const get = (p) => `fetch('${DB}/pub/test${p}.json').then(r=>r.json())`;
const pollEl = (i) => `document.querySelectorAll('.quarto-poll')[${i}]`;
const D = {}; // device ids
['a', 'b', 'c'].forEach((k, i) => { D[k] = 'dtest' + k + '00000000' + i; });

async function resetRoom() {
  await fetch(`${NODE_DB}/pub/test.json`, { method: 'DELETE' });
}

async function main() {
  const noRender = process.argv.includes('--no-render');
  if (!noRender) {
    console.log('rendering example.qmd ...');
    const r = spawnSync(process.platform === 'win32' ? 'quarto.cmd' : 'quarto', ['render', 'example.qmd'], { cwd: ROOT, encoding: 'utf-8' });
    if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  }
  console.log(`starting mock database on ${DB} ...`);
  const mock = spawn('python', [path.join(ROOT, 'dev', 'mock_firebase.py'), '--port', String(PORT), '--static', ROOT], { stdio: 'ignore' });
  try {
    /* Python can take several seconds to start; wait until the mock answers (or a mock already runs on the port). */
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try { ready = (await fetch(`${NODE_DB}/pub/x.json`)).ok; } catch (e) { await new Promise((r) => setTimeout(r, 500)); }
    }
    if (!ready) throw new Error('mock database did not start');
    await resetRoom();
    const opts = { quiet: !process.argv.includes('--verbose') };

    /* 1. choice poll: opens on its slide, live bars, closes on leaving, results slide */
    let r = await run(DECK, [
      { wait: 3000 }, { eval: `Reveal.slide(${SLIDE.clopidogrel}); 'ok'` }, { wait: 1500 },
      { eval: get('/active') },
      { eval: put(`/polls/clopidogrel/votes/${D.a}`, 0) }, { eval: put(`/polls/clopidogrel/votes/${D.b}`, 2) }, { wait: 1000 },
      { eval: `[...${pollEl(0)}.querySelectorAll('.poll-bar-count')].map(e=>e.textContent)` },
      { eval: `${pollEl(0)}.querySelector('.poll-status').textContent` },
      { eval: `Reveal.slide(${SLIDE.results}); 'ok'` }, { wait: 1200 },
      { eval: get('/polls/clopidogrel/state') },
      { eval: `document.querySelector('.quarto-poll-results').textContent.replace(/\\s+/g,' ').trim()` },
    ], opts);
    check('choice: active poll', v(r, 1), 'clopidogrel');
    check('choice: live bars', v(r, 4), ['1 (50%)', '0 (0%)', '1 (50%)']);
    check('choice: status open', v(r, 5), (s) => /Åben · 2 svar/.test(s));
    check('choice: closed on leaving', v(r, 7), 'closed');
    check('choice: results slide', v(r, 8), (s) => /CYP2C19-genotype først 1 \(50%\)/.test(s));

    /* 2. hidden results and open answers */
    r = await run(DECK, [
      { wait: 3000 }, { eval: `Reveal.slide(${SLIDE.skjult}); 'ok'` }, { wait: 1500 },
      { eval: put(`/polls/skjult/votes/${D.a}`, 1) }, { wait: 1000 },
      { eval: `${pollEl(2)}.querySelector('.poll-chart').textContent.trim()` },
      { eval: `Reveal.slide(${SLIDE.aabent}); 'ok'` }, { wait: 1500 },
      { eval: `${pollEl(2)}.querySelectorAll('.poll-bar-row').length` },
      { eval: put(`/polls/aabent/votes/${D.a}`, 'Ingen ved, hvem der betaler') }, { wait: 1000 },
      { eval: `[...${pollEl(3)}.querySelectorAll('.poll-card')].map(c=>c.textContent)` },
    ], opts);
    check('hidden: only a counter while open', v(r, 2), '1 svar');
    check('hidden: bars after closing', v(r, 4), 3);
    check('open: cards', v(r, 6), ['Ingen ved, hvem der betaler']);

    /* 3. quiz: correct hidden while open, revealed on close, scoreboard with podium, export */
    r = await run(DECK, [
      { wait: 3000 }, { eval: `Reveal.slide(${SLIDE.quiz1}); 'ok'` }, { wait: 1500 },
      { eval: get('/polls/quiz1/correct') },
      { eval: put(`/names/${D.a}`, 'Anna') }, { eval: put(`/names/${D.b}`, 'Bo') },
      { eval: put(`/polls/quiz1/votes/${D.a}`, 1) }, { eval: put(`/polls/quiz1/votes/${D.b}`, 0) }, { wait: 800 },
      { eval: `Reveal.slide(${SLIDE.scores}); 'ok'` }, { wait: 1500 },
      { eval: get('/polls/quiz1/correct') },
      { eval: `${pollEl(4)}.querySelector('.poll-status').textContent` },
      { eval: `${pollEl(4)}.querySelector('.poll-bar-row.correct .poll-bar-label').textContent` },
      { eval: `[...document.querySelectorAll('.poll-scoreboard li')].map(l=>l.textContent)` },
      { eval: `document.querySelectorAll('.poll-podium-col').length` },
    ], opts);
    check('quiz: no correct answer while open', v(r, 1), null);
    check('quiz: correct written on close', v(r, 7), 1);
    check('quiz: status shows correct count', v(r, 8), (s) => /1\/2 rigtige/.test(s));
    check('quiz: correct bar marked', v(r, 9), 'CYP2C19 ✓');
    check('quiz: scoreboard', v(r, 10), ['1Anna2 point']);
    check('quiz: podium needs two players', v(r, 11), 0);

    /* 4. multi, scale, rank, text quiz */
    r = await run(DECK, [
      { wait: 3000 }, { eval: `Reveal.slide(${SLIDE.multi1}); 'ok'` }, { wait: 1500 },
      { eval: put(`/polls/multi1/votes/${D.a}`, '0,2') }, { eval: put(`/polls/multi1/votes/${D.b}`, '2,0') }, { eval: put(`/polls/multi1/votes/${D.c}`, '1') }, { wait: 800 },
      { eval: `[...${pollEl(5)}.querySelectorAll('.poll-bar-count')].map(e=>e.textContent)` },
      { eval: `Reveal.slide(${SLIDE.skala}); 'ok'` }, { wait: 1500 },
      { eval: `${pollEl(5)}.querySelectorAll('.poll-bar-row.correct').length` },
      { eval: put(`/polls/skala/votes/${D.a}`, 4) }, { eval: put(`/polls/skala/votes/${D.b}`, 2) }, { wait: 800 },
      { eval: `${pollEl(6)}.querySelector('.poll-mean').textContent` },
      { eval: `Reveal.slide(${SLIDE.raekke}); 'ok'` }, { wait: 1500 },
      { eval: put(`/polls/raekke/votes/${D.a}`, '2,0,1,3') }, { eval: put(`/polls/raekke/votes/${D.b}`, '2,1,0,3') }, { wait: 800 },
      { eval: `[...${pollEl(7)}.querySelectorAll('.poll-ranking li .poll-name')].map(e=>e.textContent)` },
      { eval: `Reveal.slide(${SLIDE.tekstquiz}); 'ok'` }, { wait: 1500 },
      { eval: put(`/polls/tekstquiz/votes/${D.a}`, 'cyp2c19') }, { eval: put(`/polls/tekstquiz/votes/${D.b}`, 'CYP2D6') }, { wait: 800 },
      { eval: `Reveal.slide(${SLIDE.scores}); 'ok'` }, { wait: 1500 },
      { eval: `${pollEl(8)}.querySelector('.poll-status').textContent` },
      { eval: `${pollEl(8)}.querySelector('.poll-cloud span.correct').textContent` },
      { eval: `[...document.querySelectorAll('.poll-scoreboard li')].map(l=>l.textContent)` },
      { eval: `document.querySelectorAll('.poll-podium-col').length` },
    ], opts);
    check('multi: counts per option', v(r, 4), ['2 (67%)', '1 (33%)', '2 (67%)', '0 (0%)']);
    check('multi: correct set marked on close', v(r, 6), 2);
    check('scale: mean', v(r, 9), (s) => /Gennemsnit: 4\.00/.test(s));
    check('rank: average order', v(r, 13), ['Evidens for effekt', 'Pris på testen', 'Svartid', 'Patientens ønske']);
    check('text quiz: status', v(r, 18), (s) => /1\/2 rigtige/.test(s));
    check('text quiz: accepted answer marked', v(r, 19), 'cyp2c19');
    check('scores: multi exact match and text quiz add up', v(r, 20), ['1Anna4 point', '2Bo1 point']);
    check('scores: podium shown', v(r, 21), 2);

    /* 5. timed quiz with speed bonus: opened timestamp, countdown, auto close */
    r = await run(DECK, [
      { wait: 3000 }, { eval: `Reveal.slide(${SLIDE.hurtig}); 'ok'` }, { wait: 1500 },
      { eval: get('/polls/hurtig/opened') },
      { eval: `${pollEl(9)}.querySelector('.poll-timer') ? ${pollEl(9)}.querySelector('.poll-timer').textContent : 'no timer'` },
      { eval: put(`/polls/hurtig/votes/${D.a}`, 1) }, { eval: put(`/polls/hurtig/times/${D.a}`, { '.sv': 'timestamp' }) },
      { eval: patch('/polls/hurtig', { opened: Date.now() - 19500 }) }, { wait: 2000 },
      { eval: get('/polls/hurtig/state') },
      { eval: `[...document.querySelectorAll('.poll-scoreboard li')].map(l=>l.textContent)` },
    ], opts);
    check('timed: opened is a server timestamp', v(r, 1), (t) => typeof t === 'number' && t > 1.7e12);
    check('timed: countdown shown', v(r, 2), (s) => /^\d+ s$/.test(s));
    check('timed: closed automatically when time is up', v(r, 6), 'closed');
    check('timed: speed bonus between 500 and 1000', v(r, 7), (l) => /^1Anna(\d+) point/.test(l[0]) && Number(l[0].match(/Anna(\d+)/)[1]) >= 500 && Number(l[0].match(/Anna(\d+)/)[1]) <= 1000);

    /* 6. audience page: quiz name, choice vote, verdict; multi and rank UI; polling mode */
    await fetch(`${NODE_DB}/pub/test/polls/quiz1.json`, { method: 'PATCH', body: JSON.stringify({ state: 'open', correct: null }) });
    await fetch(`${NODE_DB}/pub/test/active.json`, { method: 'PUT', body: '"quiz1"' });
    r = await run(AUD, [
      { wait: 2000 },
      { eval: `document.getElementById('nf') ? 'name form' : 'no name form'` },
      { eval: `document.getElementById('ni').value='Carla'; document.getElementById('nf').requestSubmit(); 'ok'` }, { wait: 1000 },
      { eval: `document.querySelectorAll('button[data-i]')[1].click(); 'ok'` }, { wait: 1000 },
      { eval: `document.getElementById('toast').textContent` },
      { eval: patch('/polls/quiz1', { state: 'closed', correct: 1 }) }, { wait: 1000 },
      { eval: `document.querySelector('.verdict').textContent` },
      { eval: `[...document.querySelectorAll('ol.scores li')].map(l=>l.textContent)` },
      { eval: patch('/polls/multi1', { state: 'open', correct: null }) }, { eval: put('/active', 'multi1') }, { wait: 1000 },
      { eval: `document.querySelectorAll('button[data-m]')[0].click(); 'ok'` }, { wait: 300 },
      { eval: `document.querySelectorAll('button[data-m]')[2].click(); 'ok'` }, { wait: 300 },
      { eval: `document.getElementById('sendm').click(); 'ok'` }, { wait: 1000 },
      { eval: `fetch('${DB}/pub/test/polls/multi1/votes.json').then(r=>r.json()).then(j=>Object.values(j))` },
      { eval: patch('/polls/raekke', { state: 'open' }) }, { eval: put('/active', 'raekke') }, { wait: 1000 },
      { eval: `[3,1,0,2].forEach(i=>document.querySelectorAll('button[data-r]')[i].click()); 'ok'` }, { wait: 400 },
      { eval: `document.getElementById('sendr').disabled` },
      { eval: `document.getElementById('sendr').click(); 'ok'` }, { wait: 1000 },
      { eval: `fetch('${DB}/pub/test/polls/raekke/votes.json').then(r=>r.json()).then(j=>Object.values(j).pop())` },
    ], Object.assign({ mobile: true }, opts));
    check('audience: name form for quiz', v(r, 0), 'name form');
    check('audience: vote saved', v(r, 3), 'Dit svar er registreret');
    check('audience: verdict', v(r, 5), 'Rigtigt! +2 point');
    check('audience: own score listed', v(r, 6), (l) => l.some((x) => /Carla2 point/.test(x)));
    check('audience: multi vote sent as sorted indices', v(r, 12), (l) => l.includes('0,2'));
    check('audience: rank send enabled after all tapped', v(r, 16), false);
    check('audience: rank vote is the tapped order', v(r, 18), '3,1,0,2');

    r = await run(AUD + '&m=p', [
      { wait: 2500 },
      { eval: `document.querySelector('h1').textContent` },
      { eval: patch('/polls/raekke', { state: 'closed' }) }, { wait: 6000 },
      { eval: `document.querySelector('.badge').textContent` },
    ], Object.assign({ mobile: true }, opts));
    check('polling mode: shows the active poll', v(r, 0), 'Sæt i rækkefølge efter, hvad der betyder mest for dig');
    check('polling mode: picks up the change', v(r, 2), (s) => /Lukket/.test(s));
  } finally {
    try { mock.kill(); } catch (e) { /* ignore */ }
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall tests passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
