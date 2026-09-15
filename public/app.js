// Duel Simulator client. Talks to the server over WebSocket; the server is authoritative.
import { CARDS, CARD_IDS, RULES, RULES_SUMMARY, GLOSSARY, validateDeck } from '../shared/cards.js';
import { PRESETS } from '../shared/presets.js';
import { SFX } from './sfx.js';
window.SFX = SFX; // exposed for playtest verification

const $ = (id) => document.getElementById(id);
const SCREENS = ['screen-home', 'screen-library', 'screen-lobby', 'screen-build', 'screen-duel', 'screen-over'];
function show(id) { SCREENS.forEach(s => $(s).classList.toggle('hidden', s !== id)); window.scrollTo(0, 0); }
let toastT = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3500);
}

/* ================= FX — combat animations ================= */
// Per-card hit effects. To give a card its own unique hit animation, add an entry
// keyed by its card id (see shared/cards.js). Everything else uses `default`.
// Signature: (targetEl, amount) => void. Fire-and-forget; never block input.
//
// Example:
//   cinder(targetEl, amount) {
//     FX.impact(targetEl, amount);
//     FX.burst(targetEl, amount, '#ff7b3d');
//   },
const HIT_FX = {
  default(targetEl, amount) {
    SFX.hit(amount);
    FX.impact(targetEl, amount);
    FX.burst(targetEl, amount);
  },
  dotTick(targetEl, amount) {
    SFX.dot();
    FX.impact(targetEl, amount, { subtle: true });
  },
};

// Dissolve / particle theme per card kind (shared/cards.js kinds).
const KIND_FX_COLOR = {
  hit: '#ff9a3d', dot: '#ff5f2e', hot: '#5fe08a', cleanse: '#7dffb0',
  shield: '#6db7ff', weak: '#b06dff', blade: '#ffd76d', pierce: '#ffe9a8',
  aura: '#ffc46d', trap: '#c77dff', expose: '#ff7dd2', waura: '#9a6dff',
  bubble: '#7de8ff', sacrifice: '#ff5d5d',
};

const FX = {
  float(panelEl, text, cls) {
    const f = document.createElement('div');
    f.className = 'float ' + cls; f.textContent = text;
    f.style.left = (20 + Math.random() * 60) + '%'; f.style.top = '30%';
    panelEl.style.position = 'relative'; panelEl.appendChild(f);
    setTimeout(() => f.remove(), 1500);
  },
  flash(text) {
    const c = $('fx-center'); c.innerHTML = '';
    const d = document.createElement('div'); d.className = 'fx-flash'; d.textContent = text;
    c.appendChild(d); setTimeout(() => d.remove(), 1300);
  },
  shake(el, strong = true) {
    el.classList.remove('shake', 'shake-soft'); void el.offsetWidth;
    el.classList.add(strong ? 'shake' : 'shake-soft');
  },
  // Card play, Hearthstone-style: arc fly-in to board center, golden showcase
  // with the card name, then a slam beat where it dissolves into kind-themed
  // particles + a shockwave. Hit visuals elsewhere sync to the slam via cardAt.
  playCard(cardId, side) {
    const layer = $('fx-layer');
    const def = CARDS[cardId];
    if (!layer || !def) return;
    FX.cardAt = Date.now();
    SFX.whoosh();
    const color = KIND_FX_COLOR[def.kind] || '#ffcf7d';
    const el = cardEl(cardId);
    el.classList.add('fx-card');
    layer.appendChild(el);
    const cx = window.innerWidth / 2, cy = window.innerHeight * 0.44;
    const startY = side === 'you' ? window.innerHeight * 0.94 : window.innerHeight * 0.06;
    const midY = (startY + cy) / 2 - 70; // arc lift
    const at = (x, y, s) => `translate(${x}px, ${y}px) translate(-50%,-50%) scale(${s})`;
    const fly = el.animate([
      { transform: at(cx, startY, 0.5), opacity: 0 },
      { transform: at(cx, midY, 0.82), opacity: 1, offset: 0.55 },
      { transform: at(cx, cy, 1.18), opacity: 1 },
    ], { duration: 620, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
    fly.onfinish = () => {
      el.classList.add('showcase');
      el.style.filter = `drop-shadow(0 0 26px ${color})`;
      FX.flash(def.name);
      setTimeout(() => {
        // Slam: punch down, then dissolve upward into themed particles.
        el.animate([
          { transform: at(cx, cy, 1.18), opacity: 1, filter: 'blur(0px)', offset: 0 },
          { transform: at(cx, cy + 16, 1.36), opacity: 1, filter: 'blur(0px)', offset: 0.38 },
          { transform: at(cx, cy - 8, 1.02), opacity: 0, filter: 'blur(10px) brightness(1.7)', offset: 1 },
        ], { duration: 420, easing: 'ease-in', fill: 'forwards' }).onfinish = () => el.remove();
        SFX.slam();
        FX.shockwave(cx, cy, color);
        FX.burstAt(cx, cy, 26, color, 700);
        FX.burstAt(cx, cy, 10, '#ffffff', 500);
      }, 620);
    };
  },
  // Shared hit entry point — routes to a per-card effect when one exists.
  hitEffect(cardId, targetEl, amount, isDotTick = false) {
    if (isDotTick) return HIT_FX.dotTick(targetEl, amount);
    (HIT_FX[cardId] || HIT_FX.default)(targetEl, amount);
  },
  impact(targetEl, amount, { subtle = false } = {}) {
    const layer = $('fx-layer');
    if (!layer) return;
    const r = targetEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'fx-impact' + (subtle ? ' subtle' : '');
    el.style.left = (r.left + r.width / 2) + 'px';
    el.style.top = (r.top + r.height / 2) + 'px';
    el.style.setProperty('--s', subtle ? 0.65 : Math.min(1.35, 0.8 + amount / 1200));
    layer.appendChild(el);
    setTimeout(() => el.remove(), 500);
  },
  burst(targetEl, amount, color = '#ffcf7d') {
    const r = targetEl.getBoundingClientRect();
    FX.burstAt(r.left + r.width / 2, r.top + r.height / 2,
      Math.min(14, 5 + Math.floor(amount / 120)), color, 550);
  },
  burstAt(cx, cy, n, color = '#ffcf7d', dur = 550) {
    const layer = $('fx-layer');
    if (!layer) return;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('div');
      p.className = 'fx-particle';
      p.style.background = color;
      p.style.boxShadow = `0 0 8px ${color}`;
      p.style.left = cx + 'px'; p.style.top = cy + 'px';
      layer.appendChild(p);
      const ang = (Math.PI * 2 * i) / n + Math.random() * .6;
      const dist = 45 + Math.random() * 85;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 18;
      p.animate([
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(.2)`, opacity: 0 },
      ], { duration: dur + Math.random() * 350, easing: 'cubic-bezier(.17,.67,.35,1)' })
        .onfinish = () => p.remove();
    }
  },
  shockwave(cx, cy, color = '#ffcf7d') {
    const layer = $('fx-layer');
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'fx-shockwave';
    el.style.left = cx + 'px'; el.style.top = cy + 'px';
    el.style.borderColor = color;
    el.style.boxShadow = `0 0 18px ${color}`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 650);
  },
  screenShake() {
    const s = $('screen-duel');
    if (!s) return;
    s.classList.remove('screen-shake'); void s.offsetWidth;
    s.classList.add('screen-shake');
    setTimeout(() => s.classList.remove('screen-shake'), 400);
  },
  healGlow(targetEl) {
    const layer = $('fx-layer');
    if (!layer) return;
    const r = targetEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'fx-impact heal';
    el.style.left = (r.left + r.width / 2) + 'px';
    el.style.top = (r.top + r.height / 2) + 'px';
    el.style.setProperty('--s', 0.9);
    layer.appendChild(el);
    setTimeout(() => el.remove(), 500);
  },
  log(html) {
    const l = $('log'); const d = document.createElement('div'); d.innerHTML = html;
    l.appendChild(d); l.scrollTop = l.scrollHeight;
    while (l.children.length > 120) l.firstChild.remove();
  },
  clear() { $('log').innerHTML = ''; $('fx-center').innerHTML = ''; },
};

/* ================= state ================= */
let ws = null, roomSeat = -1, myToken = null, roomCode = null;
let myName = 'Player 1', lobby = null, snap = null;
let deck = [], deckSaved = false;
let confirmIdx = -1; // hand index of the armed card (Cast / Discard / Cancel popup)
let reconnectTries = 0;
const lastCardBySeat = {}; // match seat -> card id of the most recent play (for hit FX)

/* ================= websocket ================= */
function wsUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host; }

function connect() {
  return new Promise((resolve, reject) => {
    $('conn-status').textContent = 'Connecting…';
    const s = new WebSocket(wsUrl());
    s.onopen = () => { ws = s; reconnectTries = 0; $('conn-status').textContent = ''; resolve(); };
    s.onerror = () => { $('conn-status').textContent = 'Connection failed.'; reject(new Error('ws')); };
    s.onclose = onWsClose;
    s.onmessage = onMsg;
  });
}
function ensureWs() {
  if (ws && ws.readyState === 1) return Promise.resolve();
  return connect();
}
function send(m) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  else toast('Not connected.');
}
function onWsClose() {
  ws = null;
  // auto-rejoin while in a room (server keeps it ~2 min)
  if (roomCode && myToken && reconnectTries < 8) {
    reconnectTries++;
    setTimeout(() => {
      connect().then(() => send({ t: 'join', code: roomCode, token: myToken, name: myName }))
        .catch(() => {});
    }, 2000);
  }
}

function onMsg(ev) {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.t === 'room') {
    roomSeat = m.seat; myToken = m.token; roomCode = m.code;
    localStorage.setItem('duelSession', JSON.stringify({ code: m.code, token: m.token, name: myName }));
    $('lobby-code').textContent = m.code;
    show('screen-lobby');
  } else if (m.t === 'lobby') {
    const wasLobby = !$('screen-lobby').classList.contains('hidden');
    lobby = m; renderLobby();
    if (m.phase === 'build' && wasLobby) enterBuild();
  } else if (m.t === 'state') {
    snap = m.snap;
    if ($('screen-duel').classList.contains('hidden')) { FX.clear(); show('screen-duel'); }
    renderDuel(m.events || []);
    renderTimers(m.turnEndsAt, m.matchEndsAt);
  } else if (m.t === 'over') {
    showOver(m);
  } else if (m.t === 'error') {
    toast(m.msg);
  } else if (m.t === 'opponentGone') {
    $('gone-banner').classList.remove('hidden');
  } else if (m.t === 'peerBack') {
    $('gone-banner').classList.add('hidden'); toast('Opponent reconnected.');
  }
}

/* ================= card element ================= */
const KIND_STYLE = {
  hit: { cls: 'k-hit', label: '⚔ Hit' },
  dot: { cls: 'k-hit', label: '🔥 DoT' },
  shield: { cls: 'k-shield', label: '🛡 Shield' },
  hot: { cls: 'k-heal', label: '💚 Heal' },
  cleanse: { cls: 'k-heal', label: '💚 Cleanse' },
  blade: { cls: 'k-buff', label: '✨ Buff' },
  pierce: { cls: 'k-buff', label: '✨ Buff' },
  aura: { cls: 'k-buff', label: '✨ Buff' },
  bubble: { cls: 'k-buff', label: '✨ Buff' },
  weak: { cls: 'k-debuff', label: '💜 Debuff' },
  trap: { cls: 'k-debuff', label: '💜 Debuff' },
  expose: { cls: 'k-debuff', label: '💜 Debuff' },
  waura: { cls: 'k-debuff', label: '💜 Debuff' },
  sacrifice: { cls: 'k-neutral', label: '⚡ Pips' },
};

function cardEl(id, extra = '') {
  const c = CARDS[id];
  const ks = KIND_STYLE[c.kind] || KIND_STYLE.sacrifice;
  const el = document.createElement('div');
  el.className = 'card ' + ks.cls + ' ' + extra;
  el.innerHTML = `<div class="cost ${c.cost === 0 ? 'zero' : ''}">${c.cost}</div>` +
    `<div class="cname">${c.name}</div><div class="kind-tag">${ks.label}</div>` +
    `<div class="ctext">${kw(c.text)}</div>`;
  // Keyword taps open the answer key instead of playing the card.
  el.querySelectorAll('.kw').forEach(b => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openKey(b.dataset.kw);
  }));
  return el;
}

/* ================= answer key ================= */
const escHtml = (s) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const KW_RE = /\b(blade|weakness|shield|trap|pierce|aura|brace|pips|DoT|HoT|bubble|shatter|lifesteal)\b/g;
function kw(text) {
  return escHtml(text).replace(KW_RE, '<button class="kw" data-kw="$1">$1</button>');
}
let keyBuilt = false;
function buildKey() {
  if (keyBuilt) return; keyBuilt = true;
  const d = $('key-entries'); d.innerHTML = '';
  for (const k of Object.keys(GLOSSARY)) {
    const g = GLOSSARY[k];
    const div = document.createElement('div');
    div.className = 'key-entry'; div.id = 'key-' + k;
    div.innerHTML = `<h4>${escHtml(g.name)}</h4><p>${escHtml(g.text)}</p>`;
    d.appendChild(div);
  }
}
function openKey(k) {
  buildKey();
  $('key-drawer').classList.add('open');
  document.querySelectorAll('.key-entry.hl').forEach(e => e.classList.remove('hl'));
  const e = $('key-' + k);
  if (e) { e.classList.add('hl'); e.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
$('key-tab').addEventListener('click', () => { buildKey(); $('key-drawer').classList.toggle('open'); });
$('key-close').addEventListener('click', (ev) => { ev.stopPropagation(); $('key-drawer').classList.remove('open'); });
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    $('key-drawer').classList.remove('open');
    if (confirmIdx >= 0) { confirmIdx = -1; renderDuel([]); }
  }
});

function renderLibrary() {
  $('rules-list').innerHTML = RULES_SUMMARY.map(r => `<li>${r}</li>`).join('');
  const g = $('lib-grid'); g.innerHTML = '';
  for (const id of CARD_IDS) g.appendChild(cardEl(id));
}

document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  SFX.musicStop();
  roomCode = null; myToken = null; roomSeat = -1; lobby = null; snap = null;
  show('screen-home');
}));

$('btn-library').addEventListener('click', () => { location.href = '/cards'; });
$('lib-back').addEventListener('click', () => { location.href = '/'; });
$('btn-create').addEventListener('click', async () => {
  myName = $('name').value.trim() || 'Player 1';
  try { await ensureWs(); send({ t: 'create', name: myName }); }
  catch { toast('Could not connect to the server.'); }
});
$('btn-join').addEventListener('click', async () => {
  myName = $('name').value.trim() || 'Player 1';
  const code = $('join-code').value.trim().toUpperCase();
  if (!code) { toast('Enter a room code.'); return; }
  try { await ensureWs(); send({ t: 'join', code, name: myName }); }
  catch { toast('Could not connect to the server.'); }
});
$('btn-copy-link').addEventListener('click', async () => {
  if (!roomCode) return;
  const url = `${location.origin}/?code=${roomCode}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied!'); }
  catch { prompt('Copy this invite link:', url); }
});
// pre-fill the join code from a shared ?code= link
(function checkInviteCode() {
  try {
    const code = (new URLSearchParams(location.search).get('code') || '').trim().toUpperCase();
    if (code) { $('join-code').value = code; $('name').focus(); }
  } catch {}
})();
(function checkRejoin() {
  try {
    const s = JSON.parse(localStorage.getItem('duelSession') || 'null');
    if (s && s.code && s.token) {
      $('rejoin-wrap').classList.remove('hidden');
      $('btn-rejoin').addEventListener('click', async () => {
        myName = s.name || $('name').value.trim() || 'Player 1';
        try { await ensureWs(); send({ t: 'join', code: s.code, token: s.token, name: myName }); }
        catch { toast('Could not connect.'); }
      });
    }
  } catch {}
})();

/* ================= lobby ================= */
function renderLobby() {
  if (!lobby) return;
  const names = lobby.names;
  $('lobby-players').innerHTML =
    `<div>${names[0] || '?'} ${roomSeat === 0 ? '(you)' : ''}</div>` +
    `<div>${names[1] ? names[1] + (roomSeat === 1 ? ' (you)' : '') : '<span class="muted">waiting…</span>'}</div>`;
  const both = names[0] && names[1];
  $('lobby-wait').classList.toggle('hidden', !!both);
  // negotiation panel (lobby phase only)
  const negOpen = !!(both && lobby.phase === 'lobby' && lobby.neg);
  $('neg-panel').classList.toggle('hidden', !negOpen);
  if (negOpen) {
    const neg = lobby.neg;
    $('neg-first-0').textContent = names[0] + (roomSeat === 0 ? ' (you)' : '');
    $('neg-first-1').textContent = names[1] + (roomSeat === 1 ? ' (you)' : '');
    $('neg-first-0').classList.toggle('on', neg.first === 0);
    $('neg-first-1').classList.toggle('on', neg.first === 1);
    $('neg-bonus').textContent = `+${neg.p2bonus}`;
    $('neg-minus').disabled = neg.p2bonus <= RULES.p2bonusMin;
    $('neg-plus').disabled = neg.p2bonus >= RULES.p2bonusMax;
    $('neg-shuffle-0').classList.toggle('on', !neg.shuffle);
    $('neg-shuffle-1').classList.toggle('on', !!neg.shuffle);
    $('neg-status').innerHTML =
      `You: ${neg.ready[roomSeat] ? '<b>READY ✓</b>' : 'not ready'} · ` +
      `Opponent: ${neg.ready[1 - roomSeat] ? '<b>READY ✓</b>' : 'not ready'}`;
    $('btn-neg-ready').textContent = neg.ready[roomSeat] ? 'Unready' : 'Ready ✓';
  }
  // build-screen side updates
  if (both && lobby.phase === 'build') {
    const foe = 1 - roomSeat;
    $('build-shuffle-note').classList.toggle('hidden', !lobby.neg.shuffle);
    $('opp-status').innerHTML =
      `Opponent: ${lobby.hasDeck[foe] ? 'deck saved ✓' : 'building…'} · ${lobby.ready[foe] ? '<b>READY ✓</b>' : 'not ready'}`;
    if (lobby.ready[roomSeat]) { $('btn-ready').textContent = 'Unready'; }
    else { $('btn-ready').textContent = 'Ready ✓'; }
  }
}
/* negotiation: bid for turn order + second-player bonus pips + deck order */
function sendNeg(first, p2bonus, shuffle) {
  if (lobby && lobby.neg) send({ t: 'neg', first, p2bonus, shuffle });
}
$('neg-first-0').addEventListener('click', () => sendNeg(0, lobby.neg.p2bonus, lobby.neg.shuffle));
$('neg-first-1').addEventListener('click', () => sendNeg(1, lobby.neg.p2bonus, lobby.neg.shuffle));
$('neg-minus').addEventListener('click', () => sendNeg(lobby.neg.first, lobby.neg.p2bonus - 1, lobby.neg.shuffle));
$('neg-plus').addEventListener('click', () => sendNeg(lobby.neg.first, lobby.neg.p2bonus + 1, lobby.neg.shuffle));
$('neg-shuffle-0').addEventListener('click', () => sendNeg(lobby.neg.first, lobby.neg.p2bonus, false));
$('neg-shuffle-1').addEventListener('click', () => sendNeg(lobby.neg.first, lobby.neg.p2bonus, true));
$('btn-neg-ready').addEventListener('click', () => {
  if (!lobby || !lobby.neg) return;
  send({ t: lobby.neg.ready[roomSeat] ? 'neg_unready' : 'neg_ready' });
});

function enterBuild() {
  deck = []; deckSaved = false; renderPool(); renderDeck();
  $('ready-panel').classList.add('hidden');
  $('settings-row').classList.toggle('hidden', roomSeat !== 0);
  show('screen-build');
}

/* ================= deck builder ================= */
function deckCount(id) { return deck.filter(x => x === id).length; }

function renderPool() {
  const pool = $('pool'); pool.innerHTML = '';
  for (const id of CARD_IDS) {
    const n = deckCount(id);
    const el = cardEl(id, n >= RULES.copiesMax ? 'maxed' : '');
    const badge = document.createElement('div'); badge.className = 'count'; badge.textContent = n ? `×${n}` : '';
    el.appendChild(badge);
    el.title = 'Click to add to deck';
    el.addEventListener('click', () => {
      if (deckSaved) return;
      if (deckCount(id) >= RULES.copiesMax) { toast(`Max ${RULES.copiesMax} copies of ${CARDS[id].name}.`); return; }
      if (deck.length >= RULES.deckMax) { toast(`Deck is full (${RULES.deckMax}).`); return; }
      deck.push(id); renderPool(); renderDeck();
    });
    pool.appendChild(el);
  }
}

function renderDeck() {
  const list = $('deck-list'); list.innerHTML = '';
  deck.forEach((id, i) => {
    const li = document.createElement('li');
    if (i < RULES.handStart) li.classList.add('starting');
    li.innerHTML = `<span class="n">${i + 1}</span><span class="grow"><b>${CARDS[id].name}</b> <span class="muted">(${CARDS[id].cost} pip)</span></span>`;
    const up = document.createElement('button'); up.textContent = '↑'; up.title = 'Move up';
    const dn = document.createElement('button'); dn.textContent = '↓'; dn.title = 'Move down';
    const rm = document.createElement('button'); rm.textContent = '✕'; rm.title = 'Remove';
    up.addEventListener('click', () => { if (i > 0) { [deck[i - 1], deck[i]] = [deck[i], deck[i - 1]]; renderPool(); renderDeck(); } });
    dn.addEventListener('click', () => { if (i < deck.length - 1) { [deck[i + 1], deck[i]] = [deck[i], deck[i + 1]]; renderPool(); renderDeck(); } });
    rm.addEventListener('click', () => { deck.splice(i, 1); renderPool(); renderDeck(); });
    if (deckSaved) [up, dn, rm].forEach(b => b.disabled = true);
    li.append(up, dn, rm); list.appendChild(li);
  });
  $('deck-count').textContent = `${deck.length} / ${RULES.deckMin} min`;
  const err = validateDeck(deck);
  $('deck-error').textContent = deckSaved ? '' : (err || '');
  $('btn-save-deck').disabled = deckSaved || !!err;
  $('btn-save-deck').textContent = deckSaved ? 'Deck saved ✓' : 'Save deck';
}

$('btn-save-deck').addEventListener('click', () => {
  send({ t: 'deck', cards: deck });
  deckSaved = true; renderDeck();
  $('ready-panel').classList.remove('hidden');
  renderLobby();
});
$('match-minutes').addEventListener('change', (e) => send({ t: 'settings', minutes: Number(e.target.value) }));
$('btn-ready').addEventListener('click', () => {
  if (!lobby) return;
  if (lobby.ready[roomSeat]) send({ t: 'unready' });
  else send({ t: 'ready' });
});

/* ================= deck presets ================= */
(function buildPresets() {
  const row = $('preset-row');
  if (!row) return;
  for (const preset of PRESETS) {
    const b = document.createElement('button');
    b.textContent = preset.name;
    b.title = preset.desc || preset.name;
    b.addEventListener('click', () => {
      deck = [...preset.cards]; deckSaved = false;
      renderPool(); renderDeck();
      toast('Loaded ' + preset.name + ' — edit freely.');
    });
    row.appendChild(b);
  }
})();

/* ================= duel ================= */
const myMatchIdx = () => snap.seats.indexOf(roomSeat);
const seatName = (mi) => mi === myMatchIdx() ? 'You' : (lobby.names[1 - roomSeat] || 'Foe');
const isMyTurn = () => snap && snap.currentSeat === myMatchIdx();

function chipsFor(p) {
  const c = [];
  if (p.pierceBlade) c.push(`<span class="chip b">➹ pierce+30</span>`);
  if (p.outAura) c.push(`<span class="chip d">−${p.outAura.v}% out (${p.outAura.rounds})</span>`);
  if (p.wAura) c.push(`<span class="chip d">−${p.wAura.v}% weak aura (${p.wAura.rounds})</span>`);
  if (p.inAura && p.inAura.v < 0) c.push(`<span class="chip g">−${-p.inAura.v}% brace (${p.inAura.rounds})</span>`);
  if (p.inAura && p.inAura.v > 0) c.push(`<span class="chip d">+${p.inAura.v}% exposed (${p.inAura.rounds})</span>`);
  if (p.outBuff) c.push(`<span class="chip b">+${p.outBuff.v}% out (${p.outBuff.rounds})</span>`);
  for (const d of p.dots) c.push(`<span class="chip d">🔥 ${d.tick}×${d.rounds}</span>`);
  for (const h of p.hots) c.push(`<span class="chip g">💚 ${h.heal}×${h.rounds}</span>`);
  return c.join('');
}

const RING_C = 2 * Math.PI * 52;

function setOrbIcon(id, html, title) {
  const el = $(id);
  el.innerHTML = html || '';
  el.title = title || '';
  el.classList.toggle('hidden', !html);
}

// W101-style character orb: depleting HP ring, HP number in the middle,
// blades top-right, weakness top-left, shields bottom-right, traps bottom-left.
function renderOrb(prefix, p, name) {
  $(prefix + '-name').textContent = name;
  const frac = Math.max(0, Math.min(1, p.hp / RULES.maxHp));
  $(prefix + '-ring').style.strokeDashoffset = (RING_C * (1 - frac)).toFixed(1);
  const hpEl = $(prefix + '-hpnum');
  hpEl.textContent = p.hp.toLocaleString();
  hpEl.title = `${p.hp.toLocaleString()} / ${RULES.maxHp.toLocaleString()} HP`;
  setOrbIcon(prefix + '-blades',
    p.blades.length ? `🗡️${p.blades.length > 1 ? '×' + p.blades.length : ''}` : '',
    p.blades.length ? `Blades: ${p.blades.map(b => '+' + b + '%').join(', ')} — all consumed by the next damaging hit` : '');
  setOrbIcon(prefix + '-weak',
    p.weakness ? `💔−${p.weakness}%` : '',
    p.weakness ? `Weakness: −${p.weakness}% on the next outgoing hit (cannot be pierced)` : '');
  setOrbIcon(prefix + '-shields',
    p.shields ? `🛡️${p.shields > 1 ? '×' + p.shields : ''}` : '',
    p.shields ? `${p.shields} shield(s) — each damage instance uses up one` : '');
  setOrbIcon(prefix + '-traps',
    p.traps.length ? `🪤${p.traps.length > 1 ? '×' + p.traps.length : ''}` : '',
    p.traps.length ? `Traps: ${p.traps.map(t => '+' + t + '%').join(', ')} — boost the next hit(s) taken` : '');
  $(prefix + '-status').innerHTML = chipsFor(p);
  const pipLabel = prefix === 'you' ? 'You' : 'Foe';
  $(prefix + '-pips').textContent = `${pipLabel} ⚡ ${p.pips}`;
  $(prefix + '-pips').title = `${pipLabel === 'You' ? 'Your' : "Foe's"} pips`;
  // orbiting DoT/HoT indicators: up to 4 each, extras collapse into a +N bubble
  const orbEl = $(prefix + '-orbiters');
  if (orbEl) {
    let html = '', i = 0;
    const add = (cls, nums) => {
      const shown = nums.slice(0, 4);
      const extraN = nums.length > 4 ? nums.length - 3 : 0;
      if (extraN) { shown.length = 3; shown.push('+' + extraN); }
      shown.forEach((n, j) => {
        const more = j === 3 && extraN ? ' more' : '';
        html += `<span class="orbiter ${cls}${more}" style="--i:${i++}"><span class="onum">${n}</span></span>`;
      });
    };
    add('dot', (p.dots || []).map(d => d.tick));
    add('hot', (p.hots || []).map(h => h.heal));
    orbEl.innerHTML = html;
  }
}

function renderDuel(events) {
  const foeName = lobby.names[1 - roomSeat] || 'Foe';
  renderOrb('foe', snap.foe, foeName);
  renderOrb('you', snap.you, myName + ' (you)');
  $('foe-hand').textContent = `Hand: ${snap.foe.hand}`;
  $('foe-deck').textContent = `Deck: ${snap.foe.deckCount}`;
  $('you-deck').textContent = `Deck: ${snap.you.deckCount}`;
  $('deck-next').textContent = snap.you.deckNext && snap.you.deckNext.length
    ? 'Next: ' + CARDS[snap.you.deckNext[0]].name : 'Next: —';

  // arena bubble indicator
  const bl = $('bubble-line');
  if (snap.bubble) {
    const mine = snap.bubble.owner === 'you';
    bl.innerHTML = `🫧 <b>Bubble</b>: +${RULES.bubblePct}% ${mine ? 'your' : "foe's"} spells`;
    bl.classList.toggle('foe', !mine);
  } else {
    bl.innerHTML = `🫧 <b>Bubble</b>: <span class="muted">none — play Bubble to set it</span>`;
    bl.classList.remove('foe');
  }

  const mine = isMyTurn();
  $('turn-banner').textContent = snap.winner ? '' : (mine ? 'YOUR TURN' : "Opponent's turn");
  $('turn-banner').className = mine ? 'you' : 'foe';

  // card popup: drop any stale arming, then drive the Cast/Discard/Cancel bar
  if (!mine || snap.winner) confirmIdx = -1;
  if (confirmIdx >= snap.you.hand.length) confirmIdx = -1;

  // hand
  const hand = $('hand'); hand.innerHTML = '';
  hand.classList.toggle('locked', !mine || snap.winner);
  snap.you.hand.forEach((id, i) => {
    const el = cardEl(id);
    const afford = snap.you.pips >= CARDS[id].cost;
    if (!afford) el.classList.add('cant');
    if (i === confirmIdx) el.classList.add('armed');
    el.setAttribute('role', 'button');
    el.tabIndex = (mine && !snap.winner) ? 0 : -1;
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.click(); }
    });
    el.title = CARDS[id].text;
    el.addEventListener('click', () => {
      if (!mine || snap.winner) return;
      // arm the card; a second tap disarms. The popup offers Cast/Discard.
      confirmIdx = confirmIdx === i ? -1 : i;
      renderDuel([]);
    });
    hand.appendChild(el);
  });

  const cc = $('cast-confirm');
  if (confirmIdx >= 0) {
    const c = CARDS[snap.you.hand[confirmIdx]];
    const afford = snap.you.pips >= c.cost;
    $('cast-confirm-label').innerHTML =
      `<b>${c.name}</b> <span class="muted">(${c.cost} pip${c.cost === 1 ? '' : 's'})</span>`;
    $('btn-cast').disabled = !afford;
    $('btn-cast').title = afford ? '' : 'Not enough pips';
    cc.classList.remove('hidden');
  } else {
    cc.classList.add('hidden');
  }

  $('btn-pass').disabled = !mine;

  for (const e of events) handleEvent(e);
}

function handleEvent(e) {
  const panel = (mi) => $(mi === myMatchIdx() ? 'you-orb' : 'foe-orb');
  switch (e.k) {
    case 'start': {
      const mi = snap.seats.indexOf(e.first);
      const p2b = e.p2bonus ?? (RULES.pipStart[1] - RULES.pipStart[0]);
      SFX.musicStart();
      FX.log(`⚔️ Duel start — <b>${seatName(mi)}</b> ${seatName(mi) === 'You' ? 'move' : 'moves'} first. Second player +${p2b} pips.`);
      break;
    }
    case 'turn': break; // banner covers it
    case 'card': {
      const nm = CARDS[e.card].name;
      lastCardBySeat[e.seat] = e.card;
      FX.playCard(e.card, e.seat === myMatchIdx() ? 'you' : 'foe');
      FX.log(`${seatName(e.seat)} played <b>${nm}</b>.`);
      break;
    }
    case 'dmg': {
      const tgt = e.to === myMatchIdx() ? 'you' : 'foe';
      const orbEl = $(tgt === 'you' ? 'you-orb' : 'foe-orb');
      // Sync the impact to the card's slam beat when a card was just played.
      const synced = !e.dot && (Date.now() - (FX.cardAt || 0) < 1600);
      const fire = () => {
        FX.float(panel(e.to), `−${e.amount}`, 'dmg');
        FX.hitEffect(e.dot ? null : lastCardBySeat[e.from], orbEl, e.amount, !!e.dot);
        FX.shake(orbEl, e.amount >= 300);
        if (e.amount >= 500) FX.screenShake();
      };
      if (synced) setTimeout(fire, 1180); else fire();
      FX.log(`${seatName(e.from)} hit ${seatName(e.to)} for <b>${e.amount}</b>${e.dot ? ' (DoT tick)' : ''}${e.shieldUsed ? ' (shield used)' : ''}${e.trapUsed ? ' (trap used)' : ''}.`);
      break;
    }
    case 'heal': {
      const orbEl = $(e.to === myMatchIdx() ? 'you-orb' : 'foe-orb');
      const synced = Date.now() - (FX.cardAt || 0) < 1600;
      const fire = () => { FX.float(panel(e.to), `+${e.amount}`, 'heal'); FX.healGlow(orbEl); SFX.heal(); };
      if (synced) setTimeout(fire, 1180); else fire();
      FX.log(`${seatName(e.to)} healed ${e.amount}.`);
      break;
    }
    case 'pass': FX.log(`${seatName(e.seat)} passed.`); break;
    case 'timeout': FX.log(`⏱ ${seatName(e.seat)} ran out of time — auto-pass.`); break;
    case 'discard': SFX.flick(); FX.log(`${seatName(e.seat)} discarded ${e.count} card${e.count > 1 ? 's' : ''}.`); break;
    case 'draw': break;
    case 'blade': FX.log(`${seatName(e.to)} gained a +${e.v}% blade.`); break;
    case 'weak': FX.log(`${seatName(e.to)} got −${e.v}% weakness.`); break;
    case 'trap': FX.log(`${seatName(e.to)} got a +${e.v}% trap.`); break;
    case 'shield': FX.log(`${seatName(e.to)} raised a −${e.v}% shield.`); break;
    case 'pierceBlade': FX.log(`${seatName(e.to)} gained +30 pierce (next hit).`); break;
    case 'outAura': FX.log(`${seatName(e.to)} got −${e.v}% outgoing aura.`); break;
    case 'brace': FX.log(`${seatName(e.to)} gained −${e.v}% brace.`); break;
    case 'expose': FX.log(`${seatName(e.to)} is exposed: +${e.v}% incoming damage aura.`); break;
    case 'wAura': FX.log(`${seatName(e.to)} got a −${e.v}% weakness aura.`); break;
    case 'bubble': FX.log(`${seatName(e.seat)} set the bubble (+${RULES.bubblePct}% their spells).`); break;
    case 'outBuff': FX.log(`${seatName(e.to)} gained +${e.v}% outgoing aura.`); break;
    case 'dot': FX.log(`${seatName(e.to)} is burning (${e.tick}/turn × ${e.rounds}).`); break;
    case 'hot': FX.log(`${seatName(e.to)} is regenerating (${e.heal}/turn × ${e.rounds}).`); break;
    case 'sacrifice': FX.float(panel(e.to), `−${e.hp}`, 'dmg'); FX.log(`${seatName(e.to)} sacrificed ${e.hp} HP for +${e.pips} pips.`); break;
    case 'shatter': FX.log(`💥 ${seatName(e.to)}'s shield was shattered${e.count > 1 ? ` (×${e.count})` : ''}.`); break;
    case 'steal': FX.log(`${seatName(e.from)} stole ${e.pips} pip${e.pips > 1 ? 's' : ''} from ${seatName(e.to)}.`); break;
    case 'cleanse': FX.log(`${seatName(e.to)} purified ${e.count} DoT${e.count === 1 ? '' : 's'}.`); break;
    case 'warded': FX.log(`${seatName(e.to)} resisted the DoT (warded).`); break;
    case 'over': break; // handled by 'over' message
  }
}

$('btn-pass').addEventListener('click', () => send({ t: 'action', action: { type: 'pass' } }));
$('btn-cast').addEventListener('click', () => {
  if (confirmIdx < 0 || !isMyTurn() || (snap && snap.winner)) return;
  send({ t: 'action', action: { type: 'play', hand: confirmIdx } });
  confirmIdx = -1;
});
$('btn-cast-cancel').addEventListener('click', () => { confirmIdx = -1; renderDuel([]); });
$('btn-discard-one').addEventListener('click', () => {
  if (confirmIdx < 0 || !isMyTurn() || (snap && snap.winner)) return;
  // Discarding is free: the turn continues, so you can discard several
  // cards and still cast or pass afterwards.
  send({ t: 'action', action: { type: 'discard', hand: [confirmIdx] } });
  confirmIdx = -1;
});

/* ================= timers ================= */
let timerEnds = { turn: null, match: null };
let lastTickSec = -1;
function renderTimers(turnEndsAt, matchEndsAt) { timerEnds = { turn: turnEndsAt, match: matchEndsAt }; }
setInterval(() => {
  const fmt = (ms) => {
    if (ms == null) return '—';
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const now = Date.now();
  const clock = $('turn-clock'), tEl = $('turn-timer'), fill = $('turn-bar-fill');
  const ms = timerEnds.turn ? timerEnds.turn - now : null;
  if (ms == null) {
    tEl.textContent = '—'; fill.style.width = '0%';
    clock.classList.remove('low', 'crit');
  } else {
    const s = Math.max(0, ms / 1000);
    // tenths under 10s so the countdown feels live
    tEl.textContent = (s <= 10 ? s.toFixed(1) : Math.ceil(s)) + 's';
    fill.style.width = Math.max(0, Math.min(100, (s / RULES.turnSecs) * 100)).toFixed(1) + '%';
    clock.classList.toggle('low', s <= 10 && s > 5);
    clock.classList.toggle('crit', s <= 5);
    // tick each whole second of the last 5 (5,4,3,2,1 — never at 0)
    const whole = Math.ceil(s);
    if (s <= 5 && whole >= 1 && whole !== lastTickSec && !$('screen-duel').classList.contains('hidden') && !(snap && snap.winner)) {
      lastTickSec = whole;
      SFX.tick();
    }
    if (s > 5) lastTickSec = -1;
  }
  $('match-timer').textContent = '⏳ ' + fmt(timerEnds.match ? timerEnds.match - now : null);
}, 200);

/* ================= sound menu ================= */
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => SFX.unlock(), { once: true }));
$('btn-sound').addEventListener('click', (ev) => {
  ev.stopPropagation();
  SFX.unlock();
  $('sound-menu').classList.toggle('hidden');
});
document.addEventListener('click', (ev) => {
  const m = $('sound-menu');
  if (m && !m.classList.contains('hidden') && !ev.target.closest('#sound-wrap')) m.classList.add('hidden');
});
[['vol-master', 'master'], ['vol-sfx', 'sfx'], ['vol-music', 'music']].forEach(([id, kind]) => {
  const el = $(id);
  if (!el) return;
  el.value = SFX.vol[kind];
  el.addEventListener('input', () => { SFX.setVol(kind, Number(el.value)); paintMute(); });
});
// Mute toggle: zeroes master, remembers the previous level, restores on unmute.
const paintMute = () => {
  const b = $('btn-mute');
  if (b) b.textContent = SFX.vol.master === 0 ? 'Unmute' : 'Mute';
};
if ($('btn-mute')) {
  paintMute();
  $('btn-mute').addEventListener('click', (ev) => {
    ev.stopPropagation();
    SFX.unlock();
    SFX.toggleMute();
    $('vol-master').value = SFX.vol.master;
    paintMute();
  });
}

/* ================= game over ================= */
function showOver(m) {
  SFX.musicStop();
  const t = m.winner === 'you' ? '🏆 You win!' : m.winner === 'foe' ? '💀 You lose' : '🤝 Draw';
  $('over-title').textContent = t;
  $('over-sub').textContent = m.reason === 'time' ? 'Time expired — higher HP wins.' : 'Knockout.';
  show('screen-over');
}
$('btn-rematch').addEventListener('click', () => {
  send({ t: 'rematch' });
  enterBuild();
});

// /cards deep link: boot straight into the card library
if (location.pathname.startsWith('/cards')) { renderLibrary(); show('screen-library'); }
else { show('screen-home'); }
