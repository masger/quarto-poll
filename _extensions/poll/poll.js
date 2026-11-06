/* quarto-poll: presenter plugin for Quarto revealjs.
 * Reads config from window.QUARTO_POLL (injected by poll.lua), listens to the
 * Firebase Realtime Database REST streaming API and renders live results.
 * Keys: V = open/close the poll on the current slide, X = reset its votes. */
(function () {
  'use strict';

  /* The config script is injected in the header after this file, so read it lazily at init. */
  const cfg = { db: '', room: '', apiKey: '', email: '', password: '', audience: '', color: '', lang: 'da', closeOnLeave: true };
  const I18N = {
    da: { open: 'Åben', closed: 'Lukket', idle: 'Ikke startet', answers: 'svar', code: 'Kode', none: 'Ingen svar endnu',
          keyToggle: 'Afstemning: åbn/luk', keyReset: 'Afstemning: nulstil stemmer' },
    en: { open: 'Open', closed: 'Closed', idle: 'Not started', answers: 'answers', code: 'Code', none: 'No answers yet',
          keyToggle: 'Poll: open/close', keyReset: 'Poll: reset votes' },
  };
  let T = I18N.da;
  function loadConfig() {
    Object.assign(cfg, window.QUARTO_POLL || {});
    cfg.db = (cfg.db || '').replace(/\/+$/, '');
    cfg.audience = cfg.audience || 'https://masger.github.io/poll/';
    T = I18N[cfg.lang] || I18N.da;
  }

  const state = { polls: {}, token: null, refresh: null, current: null, ready: false };

  /* ---------- helpers ---------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = () => `${cfg.db}/pub/${encodeURIComponent(cfg.room)}`;
  const url = (path) => `${base()}${path}.json` + (state.token ? `?auth=${encodeURIComponent(state.token)}` : '');

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
  async function signIn() {
    if (!cfg.apiKey || !cfg.email) return;
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(cfg.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cfg.email, password: cfg.password, returnSecureToken: true }),
    });
    if (!r.ok) throw new Error('Firebase sign-in failed (' + r.status + '). Check poll.email and poll.password.');
    const j = await r.json();
    state.token = j.idToken; state.refresh = j.refreshToken;
    setTimeout(refreshToken, 50 * 60 * 1000);
  }
  async function refreshToken() {
    try {
      const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(cfg.apiKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(state.refresh),
      });
      const j = await r.json();
      state.token = j.id_token; state.refresh = j.refresh_token;
    } catch (e) { toast('Could not refresh Firebase sign-in: ' + e.message); }
    setTimeout(refreshToken, 50 * 60 * 1000);
  }

  /* ---------- writes ---------- */
  async function write(method, path, body) {
    if (!cfg.db || !cfg.room) return;
    try {
      const r = await fetch(url(path), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) toast(`Database rejected ${method} ${path} (${r.status}). Check the rules and the sign-in.`);
    } catch (e) {
      toast('No connection to the database: ' + e.message);
    }
  }

  function meta(el) {
    return {
      id: el.dataset.pollId,
      question: el.dataset.question || '',
      options: JSON.parse(el.dataset.options || '[]'),
      type: el.dataset.type || 'choice',
      auto: el.dataset.auto !== 'false',
    };
  }

  async function activate(el) {
    const m = meta(el);
    const existing = state.polls[m.id];
    const st = m.auto ? 'open' : ((existing && existing.state) || 'closed');
    await write('PATCH', `/polls/${encodeURIComponent(m.id)}`, {
      question: m.question, options: m.options, n: m.options.length, type: m.type, state: st,
    });
    await write('PUT', '/active', m.id);
  }
  async function setState(el, st) {
    await write('PATCH', `/polls/${encodeURIComponent(meta(el).id)}`, { state: st });
  }
  function toggle() {
    const el = state.current; if (!el) return;
    const p = state.polls[meta(el).id];
    setState(el, p && p.state === 'open' ? 'closed' : 'open');
  }
  function reset() {
    const el = state.current; if (!el) return;
    write('PUT', `/polls/${encodeURIComponent(meta(el).id)}/votes`, null);
  }

  /* ---------- live stream ---------- */
  function listen() {
    if (!cfg.db || !cfg.room) { toast('poll.db or poll.room is missing in the YAML header.', 20000); return; }
    const es = new EventSource(`${base()}/polls.json`);
    es.addEventListener('put', (e) => {
      const m = JSON.parse(e.data);
      state.polls = m.path === '/' ? (m.data || {}) : setPath(state.polls, m.path, m.data);
      render();
    });
    es.addEventListener('patch', (e) => {
      const m = JSON.parse(e.data);
      state.polls = patchPath(state.polls, m.path, m.data);
      render();
    });
    es.addEventListener('cancel', () => toast('The database closed the stream (read access denied).'));
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) toast('Lost the database connection. Reload the deck.'); };
  }

  /* ---------- rendering ---------- */
  function audienceUrl() {
    const sep = cfg.audience.includes('?') ? '&' : '?';
    return `${cfg.audience}${sep}r=${encodeURIComponent(cfg.room)}&db=${encodeURIComponent(cfg.db)}&l=${cfg.lang}`;
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

  function bars(options, votes) {
    const counts = options.map(() => 0);
    votes.forEach((v) => { if (Number.isInteger(v) && counts[v] !== undefined) counts[v]++; });
    const total = votes.length;
    const max = Math.max(1, ...counts);
    return options.map((o, i) => `
      <div class="poll-bar-row">
        <div class="poll-bar-label">${esc(o)}</div>
        <div class="poll-bar-track"><div class="poll-bar-fill" style="width:${(100 * counts[i] / max).toFixed(1)}%"></div></div>
        <div class="poll-bar-count">${counts[i]}${total ? ` (${Math.round(100 * counts[i] / total)}%)` : ''}</div>
      </div>`).join('');
  }

  function cloud(votes) {
    const m = new Map();
    votes.forEach((v) => {
      if (typeof v !== 'string') return;
      const k = v.trim().replace(/\s+/g, ' ');
      if (!k) return;
      const key = k.toLowerCase();
      const cur = m.get(key) || { text: k, n: 0 };
      cur.n++; m.set(key, cur);
    });
    const items = [...m.values()];
    if (!items.length) return `<div class="poll-empty">${T.none}</div>`;
    const max = Math.max(...items.map((x) => x.n));
    items.sort((a, b) => hash(a.text) - hash(b.text));
    return '<div class="poll-cloud">' + items.map((x) =>
      `<span style="font-size:${(0.7 + 1.8 * x.n / max).toFixed(2)}em" title="${x.n}">${esc(x.text)}</span>`).join(' ') + '</div>';
  }

  function cards(votes) {
    const items = votes.filter((v) => typeof v === 'string' && v.trim());
    if (!items.length) return `<div class="poll-empty">${T.none}</div>`;
    return '<div class="poll-cards">' + items.map((v) => `<div class="poll-card">${esc(v.trim())}</div>`).join('') + '</div>';
  }

  function counter(n) {
    return `<div class="poll-counter"><b>${n}</b> ${T.answers}</div>`;
  }

  function render() {
    document.querySelectorAll('.quarto-poll, .quarto-poll-results').forEach((el) => {
      const id = el.dataset.pollId;
      const poll = state.polls[id];
      const isResults = el.classList.contains('quarto-poll-results');
      const type = (poll && poll.type) || el.dataset.type || 'choice';
      const options = (poll && poll.options) || JSON.parse(el.dataset.options || '[]');
      const votes = poll && poll.votes ? Object.values(poll.votes) : [];
      const chart = isResults ? el : el.querySelector('.poll-chart');
      const hidden = !isResults && el.dataset.results === 'hidden' && poll && poll.state === 'open';
      if (chart) {
        chart.innerHTML = hidden ? counter(votes.length)
          : type === 'text' ? cloud(votes) : type === 'open' ? cards(votes) : bars(options, votes);
      }
      if (!isResults) {
        const status = el.querySelector('.poll-status');
        const st = poll ? poll.state : null;
        const label = st === 'open' ? T.open : st === 'closed' ? T.closed : T.idle;
        status.className = 'poll-status ' + (st || '');
        status.innerHTML = `<span class="poll-dot"></span>${label} · ${votes.length} ${T.answers}`;
      }
    });
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
    Reveal.addKeyBinding({ keyCode: 86, key: 'V', description: T.keyToggle }, toggle);
    Reveal.addKeyBinding({ keyCode: 88, key: 'X', description: T.keyReset }, reset);
  }

  function start() {
    if (!window.Reveal) { setTimeout(start, 50); return; }
    if (Reveal.isReady && Reveal.isReady()) init(); else Reveal.on('ready', init);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
