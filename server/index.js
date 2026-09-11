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
    orders: room.players.map(p => (p ? p.order : null)),
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
    if (!room.match || room.match.state.winner) return;
    const si = room.match.state.current;
    const { events, error } = applyAction(room.match.state, si, { type: 'pass' });
    if (!error) {
      events.push({ k: 'timeout', seat: si });
      afterAction(room, events);
    }
  }, RULES.turnSecs * 1000);
}

function afterAction(room, events) {
  const st = room.match.state;
  if (st.winner) {
    clearTimers(room);
    broadcastState(room, events);
    room.players.forEach((p, i) => {
      if (p && p.connected) send(p.ws, overMsg(st, i));
    });
    return;
  }
  armTurnTimer(room);
  broadcastState(room, events);
}

function startMatch(room) {
  const decks = room.players.map(p => p.deck);
  const [o0, o1] = room.players.map(p => p.order);
  let firstSeat; // room seat that moves first
  if (o0 === 'first' && o1 === 'second') firstSeat = 0;
  else if (o0 === 'second' && o1 === 'first') firstSeat = 1;
  else firstSeat = Math.random() < 0.5 ? 0 : 1; // both agreed on the same -> random
  const { state, events } = createMatch(decks, firstSeat);
  room.match = { state };
  const mins = room.settings.minutes;
  const now = Date.now();
  room.turnEndsAt = now + RULES.turnSecs * 1000;
  room.matchEndsAt = mins > 0 ? now + mins * 60 * 1000 : null;
  armTurnTimer(room);
  if (room.matchEndsAt) {
    room.matchTimer = setTimeout(() => {
      if (!room.match || room.match.state.winner) return;
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
        players: [{ ws, name, token: token(), deck: null, ready: false, order: null, connected: true }, null],
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
      room.players[1] = { ws, name, token: token(), deck: null, ready: false, order: null, connected: true };
      send(ws, { t: 'room', code, seat: 1, token: room.players[1].token, settings: room.settings });
      broadcastLobby(room);
      return;
    }

    if (!room || seat < 0 || !me()) return;
    const p = me();

    if (m.t === 'start_build') {
      if (room.match || room.building || !room.players[0] || !room.players[1]) return;
      room.building = true;
      room.players.forEach(pl => { if (pl) { pl.ready = false; pl.order = null; } });
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
      p.order = m.order === 'second' ? 'second' : 'first';
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
      const { events, error } = applyAction(st, si, m.action);
      if (error) { send(ws, { t: 'error', msg: error }); return; }
      afterAction(room, events);
      return;
    }

    if (m.t === 'rematch') {
      clearTimers(room);
      room.match = null;
      room.building = true;
      room.turnEndsAt = room.matchEndsAt = null;
      room.players.forEach(pl => { if (pl) { pl.ready = false; pl.order = null; } });
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
