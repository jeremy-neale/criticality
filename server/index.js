// Duel Simulator server: serves the client and runs authoritative matches over WebSocket.
// Run: npm install && node server/index.js   (PORT env respected)

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { RULES, validateDeck } from '../shared/cards.js';
import { createMatch, applyAction, snapshot } from '../shared/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    if (p === '/cards' || p === '/cards/') p = '/index.html';
    let file;
    if (p.startsWith('/shared/')) file = path.normalize(path.join(ROOT, p));
    else file = path.normalize(path.join(ROOT, 'public', p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('no'); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500); res.end('error');
  }
});

// ---------------- rooms ----------------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
const token = () => crypto.randomBytes(8).toString('hex');
// Fisher-Yates shuffle; returns a new array, leaves the original untouched.
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function lobbyMsg(room) {
  const phase = room.match ? 'duel' : (room.building ? 'build' : 'lobby');
  return {
    t: 'lobby', phase,
    names: room.players.map(p => (p ? p.name : null)),
    hasDeck: room.players.map(p => !!(p && p.deck)),
    ready: room.players.map(p => !!(p && p.ready)),
    neg: { first: room.neg.first, p2bonus: room.neg.p2bonus, shuffle: room.neg.shuffle, ready: [...room.neg.ready] },
    settings: room.settings,
    seats: [0, 1],
  };
}

function broadcastLobby(room) {
  room.players.forEach((p, i) => { if (p && p.connected) send(p.ws, { ...lobbyMsg(room), you: i }); });
}

function broadcastState(room, events) {
  const st = room.match.state;
  room.players.forEach((p, i) => {
    if (!p || !p.connected) return;
    const mi = st.seats.indexOf(i); // room seat -> match player index
    send(p.ws, {
      t: 'state',
      snap: snapshot(st, mi),
      events: events || [],
      turnEndsAt: room.turnEndsAt,
      matchEndsAt: room.matchEndsAt,
    });
  });
}

function overMsg(st, roomSeat) {
  const mi = st.seats.indexOf(roomSeat);
  return {
    t: 'over',
    winner: st.winner === 'draw' ? 'draw' : (st.winner === mi ? 'you' : 'foe'),
    reason: st.winReason,
  };
}

function clearTimers(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (room.matchTimer) clearTimeout(room.matchTimer);
  room.turnTimer = room.matchTimer = null;
}

function armTurnTimer(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    if (!room.match || room.match.state.winner !== null) return;
    const si = room.match.state.current;
    const { events, error } = applyAction(room.match.state, si, { type: 'pass' });
    if (!error) {
      events.push({ k: 'timeout', seat: si });
      afterAction(room, events);
    }
  }, RULES.turnSecs * 1000);
}

function afterAction(room, events, turnAdvanced = true) {
  const st = room.match.state;
  if (st.winner !== null) {
    clearTimers(room);
    broadcastState(room, events);
    room.players.forEach((p, i) => {
      if (p && p.connected) send(p.ws, overMsg(st, i));
    });
    return;
  }
  // Only turn-ending actions (play/pass) restart the turn clock. Discards
  // are free mid-turn moves, so the original 30s deadline keeps running.
  if (turnAdvanced) {
    armTurnTimer(room);
    room.turnEndsAt = Date.now() + RULES.turnSecs * 1000; // new turn -> fresh display deadline
  }
  broadcastState(room, events);
}

function startMatch(room) {
  let decks = room.players.map(p => p.deck);
  if (room.neg.shuffle) decks = decks.map(d => shuffled(d)); // agreed in the lobby: random deck order
  const firstSeat = room.neg.first; // room seat that moves first (negotiated in lobby)
  const p2bonus = room.neg.p2bonus;
  const { state, events } = createMatch(decks, firstSeat, p2bonus);
  room.match = { state };
  const mins = room.settings.minutes;
  const now = Date.now();
  room.turnEndsAt = now + RULES.turnSecs * 1000;
  room.matchEndsAt = mins > 0 ? now + mins * 60 * 1000 : null;
  armTurnTimer(room);
  if (room.matchEndsAt) {
    room.matchTimer = setTimeout(() => {
      if (!room.match || room.match.state.winner !== null) return;
      const st = room.match.state;
      const [a, b] = st.players.map(p => p.hp / RULES.maxHp);
      st.winner = a === b ? 'draw' : (a > b ? 0 : 1);
      st.winReason = 'time';
      clearTimers(room);
      broadcastState(room, [{ k: 'over', winner: st.winner }]);
      room.players.forEach((p, i) => {
        if (p && p.connected) send(p.ws, overMsg(st, i));
      });
    }, room.matchEndsAt - now);
  }
  broadcastLobby(room);
  broadcastState(room, events);
}

// ---------------- websocket ----------------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  // A malformed frame (e.g. unmasked client frame) raises 'error' on the
  // socket; without a handler Node treats it as uncaught and kills the
  // whole process. Never let one bad client take down every room.
  ws.on('error', () => {});
  ws.on('pong', () => { ws.isAlive = true; });
  let room = null, seat = -1;

  const me = () => (room && room.players[seat]) || null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.t === 'create') {
      const code = makeCode();
      const name = String(m.name || 'Player 1').slice(0, 24);
      room = {
        code, settings: { minutes: RULES.defaultMatchMins },
        players: [{ ws, name, token: token(), deck: null, ready: false, connected: true }, null],
        neg: { first: 0, p2bonus: RULES.pipStart[1] - RULES.pipStart[0], shuffle: false, ready: [false, false] },
        match: null, building: false, turnEndsAt: null, matchEndsAt: null, turnTimer: null, matchTimer: null,
        cleanupTimer: null,
      };
      rooms.set(code, room);
      seat = 0;
      send(ws, { t: 'room', code, seat: 0, token: room.players[0].token, settings: room.settings });
      broadcastLobby(room);
      return;
    }

    if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase().trim();
      room = rooms.get(code);
      if (!room) { send(ws, { t: 'error', msg: 'Room not found. Check the code.' }); room = null; return; }
      // Rejoin with token?
      if (m.token) {
        const idx = room.players.findIndex(p => p && p.token === m.token);
        if (idx >= 0) {
          seat = idx;
          const p = room.players[idx];
          p.ws = ws; p.connected = true;
          if (m.name) p.name = String(m.name).slice(0, 24);
          if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
          send(ws, { t: 'room', code, seat: idx, token: p.token, settings: room.settings, rejoin: true });
          broadcastLobby(room);
          if (room.match) broadcastState(room, []);
          const other = room.players[1 - idx];
          if (other && other.connected) send(other.ws, { t: 'peerBack' });
          return;
        }
      }
      if (room.players[1]) { send(ws, { t: 'error', msg: 'Room is full.' }); room = null; return; }
      seat = 1;
      const name = String(m.name || 'Player 2').slice(0, 24);
      room.players[1] = { ws, name, token: token(), deck: null, ready: false, connected: true };
      send(ws, { t: 'room', code, seat: 1, token: room.players[1].token, settings: room.settings });
      broadcastLobby(room);
      return;
    }

    if (!room || seat < 0 || !me()) return;
    const p = me();

    // Turn-order / pip negotiation (lobby phase only). Changing any option
    // un-readies both players, so nobody gets locked into settings they
    // didn't agree to.
    if (m.t === 'neg') {
      if (room.match || room.building) return;
      const first = m.first === 1 ? 1 : 0;
      let p2bonus = Math.round(Number(m.p2bonus));
      if (!Number.isFinite(p2bonus)) return;
      p2bonus = Math.max(RULES.p2bonusMin, Math.min(RULES.p2bonusMax, p2bonus));
      const shuffle = m.shuffle === true;
      const n = room.neg;
      if (n.first === first && n.p2bonus === p2bonus && n.shuffle === shuffle) return; // no-op
      n.first = first; n.p2bonus = p2bonus; n.shuffle = shuffle;
      n.ready = [false, false];
      broadcastLobby(room);
      return;
    }

    if (m.t === 'neg_ready') {
      if (room.match || room.building || !room.players[0] || !room.players[1]) return;
      room.neg.ready[seat] = true;
      if (room.neg.ready[0] && room.neg.ready[1]) {
        // Both agreed: advance to deck building.
        room.building = true;
        room.players.forEach(pl => { if (pl) pl.ready = false; });
      }
      broadcastLobby(room);
      return;
    }

    if (m.t === 'neg_unready') {
      if (room.match || room.building) return;
      room.neg.ready[seat] = false;
      broadcastLobby(room);
      return;
    }

    if (m.t === 'deck') {
      if (room.match) return;
      const err = validateDeck(m.cards);
      if (err) { send(ws, { t: 'error', msg: err }); return; }
      p.deck = [...m.cards];
      p.ready = false;
      broadcastLobby(room);
      return;
    }

    if (m.t === 'settings') {
      if (seat !== 0 || room.match) return;
      const mins = Number(m.minutes);
      if (![10, 15, 20, 30, 0].includes(mins)) return;
      room.settings.minutes = mins;
      room.players.forEach(pl => { if (pl) pl.ready = false; });
      broadcastLobby(room);
      return;
    }

    if (m.t === 'ready') {
      if (room.match || !p.deck) return;
      p.ready = true;
      broadcastLobby(room);
      if (room.players[0] && room.players[1] && room.players[0].ready && room.players[1].ready) {
        startMatch(room);
      }
      return;
    }

    if (m.t === 'unready') {
      if (room.match) return;
      p.ready = false;
      broadcastLobby(room);
      return;
    }

    if (m.t === 'action') {
      if (!room.match) return;
      const st = room.match.state;
      // map room seat -> match player index
      const si = st.seats.indexOf(seat);
      const prevCurrent = st.current;
      const { events, error } = applyAction(st, si, m.action);
      if (error) { send(ws, { t: 'error', msg: error }); return; }
      afterAction(room, events, st.current !== prevCurrent);
      return;
    }

    if (m.t === 'rematch') {
      clearTimers(room);
      room.match = null;
      room.building = true; // keep the negotiated turn order/pips for the rematch
      room.turnEndsAt = room.matchEndsAt = null;
      room.players.forEach(pl => { if (pl) pl.ready = false; });
      broadcastLobby(room);
      return;
    }
  });

  ws.on('close', () => {
    if (!room || seat < 0) return;
    const p = room.players[seat];
    if (p) p.connected = false;
    const other = room.players[1 - seat];
    if (other && other.connected) send(other.ws, { t: 'opponentGone' });
    // Keep the room briefly for rejoin; delete if abandoned.
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => {
      const any = room.players.some(pl => pl && pl.connected);
      if (!any) { clearTimers(room); rooms.delete(room.code); }
    }, 120000);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

httpServer.listen(PORT, () => console.log(`Duel Simulator on :${PORT}`));
