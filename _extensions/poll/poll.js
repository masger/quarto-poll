/* quarto-poll: presenter plugin for Quarto revealjs.
 * Reads config from window.QUARTO_POLL (injected by poll.lua), listens to the
 * Firebase Realtime Database REST streaming API and renders live results.
 * Keys: V open/close, X reset votes on the slide, R reset the whole room, E export CSV. */
(function () {
  'use strict';

  /* The config script is injected in the header after this file, so read it lazily at init. */
  const cfg = { db: '', room: '', apiKey: '', email: '', password: '', audience: '', audienceMode: 'stream', color: '', lang: 'da', closeOnLeave: true };
  const I18N = {
    da: { open: 'Åben', closed: 'Lukket', idle: 'Ikke startet', answers: 'svar', code: 'Kode', none: 'Ingen svar endnu',
          keyToggle: 'Afstemning: åbn/luk', keyReset: 'Afstemning: nulstil stemmer', keyResetAll: 'Afstemning: nulstil alle svar og point',
          keyExport: 'Afstemning: eksportér svar som CSV', correct: 'rigtige', points: 'point', noScores: 'Ingen point endnu', anonymous: 'Anonym',
          confirmAll: 'Nulstil alle svar, point og navne i dette rum?', mean: 'Gennemsnit', seconds: 's', timeUp: 'Tiden er gået',
          promptPassword: (e) => `Kodeord til Firebase-brugeren ${e} (huskes i denne browser):`, noPassword: 'Intet kodeord: afstemningerne kan ikke styres.',
          exported: 'CSV gemt', nothing: 'Ingen svar at eksportere', name: 'Navn', answer: 'Svar', device: 'Enhed', question: 'Spørgsmål' },
    en: { open: 'Open', closed: 'Closed', idle: 'Not started', answers: 'answers', code: 'Code', none: 'No answers yet',
          keyToggle: 'Poll: open/close', keyReset: 'Poll: reset votes', keyResetAll: 'Poll: reset all answers and points',
          keyExport: 'Poll: export answers as CSV', correct: 'correct', points: 'points', noScores: 'No points yet', anonymous: 'Anonymous',
          confirmAll: 'Reset all answers, points and names in this room?', mean: 'Mean', seconds: 's', timeUp: 'Time is up',
          promptPassword: (e) => `Password for the Firebase user ${e} (remembered in this browser):`, noPassword: 'No password: polls cannot be controlled.',
          exported: 'CSV saved', nothing: 'No answers to export', name: 'Name', answer: 'Answer', device: 'Device', question: 'Question' },
  };
  let T = I18N.da;
  function loadConfig() {
    Object.assign(cfg, window.QUARTO_POLL || {});
    cfg.db = (cfg.db || '').replace(/\/+$/, '');
    cfg.audience = cfg.audience || 'https://masger.github.io/poll/';
    T = I18N[cfg.lang] || I18N.da;
  }

  /* room = { active, polls: {id: {...}}, names: {device: name} } mirrored from the database */
  const state = { room: {}, token: null, refresh: null, current: null, ready: false, offset: 0, closing: null };
  const polls = () => state.room.polls || {};

  /* ---------- helpers ---------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = () => `${cfg.db}/pub/${encodeURIComponent(cfg.room)}`;
  const url = (path) => `${base()}${path}.json` + (state.token ? `?auth=${encodeURIComponent(state.token)}` : '');
  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  const now = () => Date.now() + state.offset;

  function toast(msg, ms) {
    let el = document.querySelector('.poll-toast');
    if (!el) { el = document.createElement('div'); el.className = 'poll-toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = 'none'; }, ms || 6000);
    console.warn('[poll]', msg);
  }

  function setPath(root, path, data) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return data === null || data === undefined ? {} : data;
    if (typeof root !== 'object' || root === null) root = {};
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (data === null || data === undefined) delete node[last]; else node[last] = data;
    return root;
  }
  function patchPath(root, path, data) {
    Object.keys(data || {}).forEach((k) => { root = setPath(root, path + '/' + k, data[k]); });
    return root;
  }

  /* ---------- auth (Firebase email/password via REST) ---------- */
  const refreshKey = () => 'quarto-poll-refresh:' + cfg.email;
  function remember(refresh) {
    if (cfg.password) return;
    try { localStorage.setItem(refreshKey(), refresh); } catch (e) { /* ignore */ }
  }
  async function refreshWith(refresh) {
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(cfg.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refresh),
    });
    if (!r.ok) throw new Error('refresh failed');
    const j = await r.json();
    state.token = j.id_token; state.refresh = j.refresh_token;
    remember(j.refresh_token);
    setTimeout(refreshToken, 50 * 60 * 1000);
  }
  async function refreshToken() {
    try { await refreshWith(state.refresh); }
    catch (e) { toast('Could not refresh the Firebase sign-in: ' + e.message); setTimeout(refreshToken, 60 * 1000); }
  }
  async function signIn() {
    if (!cfg.apiKey || !cfg.email) return;
    /* A refresh token remembered from an earlier session avoids the password prompt. */
    let stored = null;
    try { stored = cfg.password ? null : localStorage.getItem(refreshKey()); } catch (e) { /* ignore */ }
    if (stored) {
      try { await refreshWith(stored); return; } catch (e) { try { localStorage.removeItem(refreshKey()); } catch (e2) { /* ignore */ } }
    }
    const password = cfg.password || window.prompt(T.promptPassword(cfg.email)) || '';
    if (!password) throw new Error(T.noPassword);
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(cfg.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cfg.email, password, returnSecureToken: true }),
    });
    if (!r.ok) throw new Error('Firebase sign-in failed (' + r.status + '). Check poll.email and the password.');
    const j = await r.json();
    state.token = j.idToken; state.refresh = j.refreshToken;
    remember(j.refreshToken);
    setTimeout(refreshToken, 50 * 60 * 1000);
  }

  /* ---------- writes ---------- */
  async function write(method, path, body) {
    if (!cfg.db || !cfg.room) return null;
    try {
      const r = await fetch(url(path), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { toast(`Database rejected ${method} ${path} (${r.status}). Check the rules and the sign-in.`); return null; }
      return await r.json();
    } catch (e) {
      toast('No connection to the database: ' + e.message);
      return null;
    }
  }

  function meta(el) {
    const m = JSON.parse(el.dataset.poll || '{}');
    m.options = m.options || [];
    return m;
  }

  /* The correct answer is stored as a number (choice), "1,2" (multi) or "a|b" (text). */
  function correctValue(m) {
    if (!m.quiz) return null;
    if (m.type === 'multi') return (m.correct || []).slice().sort((a, b) => a - b).join(',');
    if (m.type === 'text') return (m.correct || []).join('|');
    return m.correct;
  }

  async function activate(el) {
    const m = meta(el);
    const existing = polls()[m.id];
    const st = m.auto ? 'open' : ((existing && existing.state) || 'closed');
    const body = {
      question: m.question, options: m.options, n: m.options.length, type: m.type, state: st,
      quiz: !!m.quiz, points: m.points || 1, time: m.time || 0, speed: !!m.speed, min: m.min === undefined ? null : m.min,
      correct: st === 'closed' ? correctValue(m) : null,
    };
    if (st === 'open') body.opened = { '.sv': 'timestamp' };
    await write('PATCH', `/polls/${encodeURIComponent(m.id)}`, body);
    await write('PUT', '/active', m.id);
    if (st === 'open') await syncClock(m.id);
  }
  /* Estimate the server clock from the timestamp the database assigned when the poll opened. */
  async function syncClock(id) {
    try {
      const sent = Date.now();
      const r = await fetch(`${base()}/polls/${encodeURIComponent(id)}/opened.json`);
      const opened = await r.json();
      if (typeof opened === 'number') state.offset = opened - sent;
    } catch (e) { /* keep the local clock */ }
  }
  async function setState(el, st) {
    const m = meta(el);
    const body = { state: st, correct: st === 'closed' ? correctValue(m) : null };
    if (st === 'open') body.opened = { '.sv': 'timestamp' };
    await write('PATCH', `/polls/${encodeURIComponent(m.id)}`, body);
    if (st === 'open') await syncClock(m.id);
  }
  function toggle() {
    const el = state.current; if (!el) return;
    const p = polls()[meta(el).id];
    setState(el, p && p.state === 'open' ? 'closed' : 'open');
  }
  function reset() {
    const el = state.current; if (!el) return;
    const id = encodeURIComponent(meta(el).id);
    write('PATCH', `/polls/${id}`, { votes: null, times: null });
  }
  async function resetAll() {
    if (!window.confirm(T.confirmAll)) return;
    await write('PUT', '/polls', null);
    await write('PUT', '/names', null);
    if (state.current) await activate(state.current);
  }

  /* ---------- export ---------- */
  function exportCsv() {
    const names = state.room.names || {};
    const rows = [[T.question, 'id', 'type', T.device, T.name, T.answer, 'label', 'time_ms', 'correct', T.points]];
    Object.keys(polls()).forEach((id) => {
      const p = polls()[id];
      if (!p || !p.votes) return;
      Object.keys(p.votes).forEach((dev) => {
        const v = p.votes[dev];
        rows.push([p.question || '', id, p.type, dev, names[dev] || '', v, label(p, v),
          p.times && p.times[dev] && p.opened ? p.times[dev] - p.opened : '',
          p.quiz && isCorrect(p, v) ? 1 : (p.quiz ? 0 : ''), p.quiz ? pointsFor(p, dev) : '']);
      });
    });
    if (rows.length === 1) { toast(T.nothing); return; }
    const csv = '﻿' + rows.map((r) => r.map((c) => '"' + String(c === undefined || c === null ? '' : c).replace(/"/g, '""') + '"').join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${cfg.room}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    toast(T.exported, 2000);
  }
  function label(p, v) {
    const o = p.options || [];
    if (typeof v === 'number') return o[v] !== undefined ? o[v] : v;
    if (typeof v === 'string' && (p.type === 'multi' || p.type === 'rank')) return v.split(',').map((i) => o[Number(i)]).join(' | ');
    return v;
  }

  /* ---------- live stream ---------- */
  function listen() {
    if (!cfg.db || !cfg.room) { toast('poll.db or poll.room is missing in the YAML header.', 20000); return; }
    const es = new EventSource(`${base()}.json`);
    es.addEventListener('put', (e) => {
      const m = JSON.parse(e.data);
      state.room = m.path === '/' ? (m.data || {}) : setPath(state.room, m.path, m.data);
      render();
    });
    es.addEventListener('patch', (e) => {
      const m = JSON.parse(e.data);
      state.room = patchPath(state.room, m.path, m.data);
      render();
    });
    es.addEventListener('cancel', () => toast('The database closed the stream (read access denied).'));
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) toast('Lost the database connection. Reload the deck.'); };
  }

  /* ---------- scoring ---------- */
  function isCorrect(p, v) {
    if (!p || !p.quiz || p.correct === undefined || p.correct === null || v === undefined) return false;
    if (p.type === 'multi') return typeof v === 'string' && v.split(',').map(Number).sort((a, b) => a - b).join(',') === String(p.correct);
    if (p.type === 'text') return typeof v === 'string' && String(p.correct).split('|').includes(norm(v));
    return v === p.correct;
  }
  function pointsFor(p, dev) {
    if (!isCorrect(p, p.votes && p.votes[dev])) return 0;
    const base = Number(p.points || 1);
    if (p.speed && p.time && p.opened && p.times && typeof p.times[dev] === 'number') {
      const f = Math.min(1, Math.max(0, (p.times[dev] - p.opened) / (p.time * 1000)));
      return Math.round(base * (1 - 0.5 * f));
    }
    return base;
  }
  function scores() {
    const totals = {};
    Object.values(polls()).forEach((p) => {
      if (!p || !p.quiz || !p.votes) return;
      Object.keys(p.votes).forEach((dev) => { const pts = pointsFor(p, dev); if (pts) totals[dev] = (totals[dev] || 0) + pts; });
    });
    const names = state.room.names || {};
    return Object.keys(totals)
      .map((dev) => ({ dev, name: names[dev] || T.anonymous, points: totals[dev] }))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  }

  function leaderboard(top, podium) {
    const rows = scores().slice(0, top);
    if (!rows.length) return `<div class="poll-empty">${T.noScores}</div>`;
    /* Dense ranks, so players with the same points share a place (also on the podium). */
    let rank = 0, prev = null;
    rows.forEach((r, i) => { if (r.points !== prev) { rank = i + 1; prev = r.points; } r.rank = rank; });
    let html = '';
    if (podium && rows.length >= 2) {
      const order = [rows[1], rows[0], rows[2]].filter(Boolean);
      html += '<div class="poll-podium">' + order.map((r, i) => {
        const slot = [2, 1, 3][i];
        return `<div class="poll-podium-col place-${slot}"><div class="poll-podium-name">${esc(r.name)}</div><div class="poll-podium-block"><span>${r.rank}</span><small>${r.points} ${T.points}</small></div></div>`;
      }).join('') + '</div>';
    }
    html += '<ol class="poll-scoreboard">' + rows.map((r) =>
      `<li><span class="poll-rank">${r.rank}</span><span class="poll-name">${esc(r.name)}</span><span class="poll-points">${r.points} ${T.points}</span></li>`
    ).join('') + '</ol>';
    return html;
  }

  /* ---------- rendering ---------- */
  function audienceUrl() {
    const sep = cfg.audience.includes('?') ? '&' : '?';
    const mode = cfg.audienceMode === 'polling' ? '&m=p' : '';
    return `${cfg.audience}${sep}r=${encodeURIComponent(cfg.room)}&db=${encodeURIComponent(cfg.db)}&l=${cfg.lang}${mode}`;
  }
  function renderStatic() {
    if (cfg.color) document.documentElement.style.setProperty('--poll-color', cfg.color);
    document.querySelectorAll('.quarto-poll').forEach((el) => {
      const qrEl = el.querySelector('.poll-qr');
      if (qrEl && !qrEl.firstChild && window.qrcode) {
        const qr = window.qrcode(0, 'M');
        qr.addData(audienceUrl());
        qr.make();
        qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      }
      const join = el.querySelector('.poll-join');
      if (join) {
        const shown = cfg.audience.replace(/^https?:\/\//, '').replace(/\/$/, '');
        join.innerHTML = `${esc(shown)}<br>${T.code}: <b>${esc(cfg.room)}</b>`;
      }
    });
  }

  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

  function barRows(options, counts, total, correctSet, extraClass) {
    const max = Math.max(1, ...counts);
    return options.map((o, i) => `
      <div class="poll-bar-row${correctSet && correctSet.has(i) ? ' correct' : ''}${extraClass || ''}">
        <div class="poll-bar-label">${esc(o)}${correctSet && correctSet.has(i) ? ' ✓' : ''}</div>
        <div class="poll-bar-track"><div class="poll-bar-fill" style="width:${(100 * counts[i] / max).toFixed(1)}%"></div></div>
        <div class="poll-bar-count">${counts[i]}${total ? ` (${Math.round(100 * counts[i] / total)}%)` : ''}</div>
      </div>`).join('');
  }
  function bars(options, votes, correct) {
    const counts = options.map(() => 0);
    votes.forEach((v) => { if (Number.isInteger(v) && counts[v] !== undefined) counts[v]++; });
    return barRows(options, counts, votes.length, Number.isInteger(correct) ? new Set([correct]) : null);
  }
  function multiBars(options, votes, correct) {
    const counts = options.map(() => 0);
    votes.forEach((v) => { if (typeof v === 'string') v.split(',').forEach((i) => { if (counts[Number(i)] !== undefined) counts[Number(i)]++; }); });
    const set = typeof correct === 'string' ? new Set(correct.split(',').map(Number)) : null;
    return barRows(options, counts, votes.length, set);
  }
  function scaleChart(p, options, votes) {
    const counts = options.map(() => 0);
    let sum = 0, n = 0;
    votes.forEach((v) => { if (Number.isInteger(v) && counts[v] !== undefined) { counts[v]++; sum += v; n++; } });
    const min = Number(p && p.min !== undefined && p.min !== null ? p.min : 1);
    const mean = n ? (min + sum / n) : null;
    return barRows(options, counts, votes.length, null, ' scale') +
      (mean !== null ? `<div class="poll-mean">${T.mean}: <b>${mean.toFixed(2)}</b></div>` : '');
  }
  function rankChart(options, votes) {
    const sums = options.map(() => 0), ns = options.map(() => 0);
    votes.forEach((v) => { if (typeof v !== 'string') return; v.split(',').forEach((idx, pos) => { const i = Number(idx); if (sums[i] !== undefined) { sums[i] += pos + 1; ns[i]++; } }); });
    const rows = options.map((o, i) => ({ o, mean: ns[i] ? sums[i] / ns[i] : null })).sort((a, b) => (a.mean === null) - (b.mean === null) || a.mean - b.mean);
    if (!votes.length) return `<div class="poll-empty">${T.none}</div>`;
    return '<ol class="poll-ranking">' + rows.map((r) => `<li><span class="poll-name">${esc(r.o)}</span><span class="poll-points">${r.mean === null ? '' : r.mean.toFixed(2)}</span></li>`).join('') + '</ol>';
  }
  function cloud(votes, correct) {
    const accepted = typeof correct === 'string' ? new Set(correct.split('|')) : null;
    const m = new Map();
    votes.forEach((v) => {
      if (typeof v !== 'string') return;
      const k = v.trim().replace(/\s+/g, ' ');
      if (!k) return;
      const key = k.toLowerCase();
      const cur = m.get(key) || { text: k, n: 0, ok: accepted ? accepted.has(key) : false };
      cur.n++; m.set(key, cur);
    });
    const items = [...m.values()];
    if (!items.length) return `<div class="poll-empty">${T.none}</div>`;
    const max = Math.max(...items.map((x) => x.n));
    items.sort((a, b) => hash(a.text) - hash(b.text));
    return '<div class="poll-cloud">' + items.map((x) =>
      `<span class="${x.ok ? 'correct' : ''}" style="font-size:${(0.7 + 1.8 * x.n / max).toFixed(2)}em" title="${x.n}">${esc(x.text)}</span>`).join(' ') + '</div>';
  }
  function cards(votes) {
    const items = votes.filter((v) => typeof v === 'string' && v.trim());
    if (!items.length) return `<div class="poll-empty">${T.none}</div>`;
    return '<div class="poll-cards">' + items.map((v) => `<div class="poll-card">${esc(v.trim())}</div>`).join('') + '</div>';
  }
  function counter(n) {
    return `<div class="poll-counter"><b>${n}</b> ${T.answers}</div>`;
  }

  function remaining(p) {
    if (!p || p.state !== 'open' || !p.time || typeof p.opened !== 'number') return null;
    return Math.max(0, Math.ceil((p.opened + p.time * 1000 - now()) / 1000));
  }

  function render() {
    document.querySelectorAll('.quarto-poll, .quarto-poll-results').forEach((el) => {
      const id = el.dataset.pollId;
      const poll = polls()[id];
      const isResults = el.classList.contains('quarto-poll-results');
      const m = isResults ? { options: (poll && poll.options) || [], type: (poll && poll.type) || 'choice' } : meta(el);
      const type = (poll && poll.type) || m.type;
      const options = (poll && poll.options) || m.options;
      const votes = poll && poll.votes ? Object.values(poll.votes) : [];
      const chart = isResults ? el : el.querySelector('.poll-chart');
      const st = poll ? poll.state : null;
      const hidden = !isResults && el.dataset.results === 'hidden' && st === 'open';
      const correct = poll && poll.quiz && st === 'closed' && poll.correct !== undefined && poll.correct !== null ? poll.correct : null;
      if (chart) {
        chart.innerHTML = hidden ? counter(votes.length)
          : type === 'text' ? cloud(votes, correct)
          : type === 'open' ? cards(votes)
          : type === 'multi' ? multiBars(options, votes, correct)
          : type === 'scale' ? scaleChart(poll || m, options, votes)
          : type === 'rank' ? rankChart(options, votes)
          : bars(options, votes, correct);
      }
      if (!isResults) {
        const status = el.querySelector('.poll-status');
        const label = st === 'open' ? T.open : st === 'closed' ? T.closed : T.idle;
        let extra = '';
        if (correct !== null) extra = ` · ${votes.length ? Object.keys(poll.votes).filter((d) => isCorrect(poll, poll.votes[d])).length : 0}/${votes.length} ${T.correct}`;
        const left = remaining(poll);
        const timer = left === null ? '' : `<span class="poll-timer${left <= 5 ? ' urgent' : ''}">${left} ${T.seconds}</span>`;
        status.className = 'poll-status ' + (st || '');
        status.innerHTML = `<span class="poll-dot"></span>${label} · ${votes.length} ${T.answers}${extra}${timer}`;
      }
    });
    document.querySelectorAll('.quarto-poll-scores').forEach((el) => {
      el.innerHTML = leaderboard(Number(el.dataset.top || 10), el.dataset.podium !== 'false');
    });
  }

  /* Countdown: re-render the timer every 250 ms and close the poll when the time is up. */
  function tick() {
    const el = state.current; if (!el) return;
    const id = meta(el).id;
    const p = polls()[id];
    const left = remaining(p);
    if (left === null) return;
    const t = el.querySelector('.poll-timer');
    if (t) { t.textContent = `${left} ${T.seconds}`; t.classList.toggle('urgent', left <= 5); }
    if (left === 0 && state.closing !== id) {
      state.closing = id;
      setState(el, 'closed').then(() => { state.closing = null; toast(T.timeUp, 2000); });
    }
  }

  /* ---------- reveal hooks ---------- */
  function pollIn(slide) { return slide ? slide.querySelector('.quarto-poll') : null; }
  async function onSlide(cur, prev) {
    const p = pollIn(prev);
    if (p && cfg.closeOnLeave) await setState(p, 'closed');
    const c = pollIn(cur);
    state.current = c;
    if (c) await activate(c);
  }

  function init() {
    if (state.ready) return;
    state.ready = true;
    loadConfig();
    renderStatic();
    render();
    listen();
    signIn().catch((e) => toast(e.message, 20000)).then(() => {
      Reveal.on('slidechanged', (e) => onSlide(e.currentSlide, e.previousSlide));
      onSlide(Reveal.getCurrentSlide(), null);
    });
    setInterval(tick, 250);
    Reveal.addKeyBinding({ keyCode: 86, key: 'V', description: T.keyToggle }, toggle);
    Reveal.addKeyBinding({ keyCode: 88, key: 'X', description: T.keyReset }, reset);
    Reveal.addKeyBinding({ keyCode: 82, key: 'R', description: T.keyResetAll }, resetAll);
    Reveal.addKeyBinding({ keyCode: 69, key: 'E', description: T.keyExport }, exportCsv);
  }

  function start() {
    if (!window.Reveal) { setTimeout(start, 50); return; }
    if (Reveal.isReady && Reveal.isReady()) init(); else Reveal.on('ready', init);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
