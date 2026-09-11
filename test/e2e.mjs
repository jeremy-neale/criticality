// E2E: boots the real server, plays a full game between two WS clients.
// Run: node test/e2e.mjs
import WebSocket from 'ws';
import { CARDS } from '../shared/cards.js';

process.env.PORT = '18081';
await import('../server/index.js');
await new Promise(r => setTimeout(r, 400));

const URL = 'ws://localhost:18081';
const fail = (msg) => { console.error('E2E FAIL:', msg); process.exit(1); };

function makeClient() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = {};
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (waiters[m.t]?.length) waiters[m.t].shift()(m);
    else inbox.push(m);
  });
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    open: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    next: (t, timeout = 8000) => new Promise((resolve, reject) => {
      const i = inbox.findIndex(m => m.t === t);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + t)), timeout);
      (waiters[t] ||= []).push((m) => { clearTimeout(timer); resolve(m); });
    }),
  };
}

const aggroDeck = () => ['spark', 'bolt', 'strike', 'blast', 'cataclysm', 'jab', 'hook', 'lash', 'sunder', 'smolder']
  .flatMap(id => [id, id, id, id]); // 40 cards, 4-copy max respected

const A = makeClient(), B = makeClient();
await A.open; await B.open;
console.log('both connected');

// bad room code -> error
B.send({ t: 'join', code: 'ZZZZ', name: 'Bo' });
const errJoin = await B.next('error');
if (!/not found/i.test(errJoin.msg)) fail('bad code should error, got: ' + errJoin.msg);
console.log('bad code rejected OK');

// create + join
A.send({ t: 'create', name: 'Al' });
const roomA = await A.next('room');
if (roomA.seat !== 0 || !roomA.token) fail('create failed');
B.send({ t: 'join', code: roomA.code, name: 'Bo' });
const roomB = await B.next('room');
if (roomB.seat !== 1) fail('join failed');
console.log('room', roomA.code, 'created+joined');

// invalid deck rejected
A.send({ t: 'deck', cards: aggroDeck().slice(0, 39) });
const errDeck = await A.next('error');
if (!/at least 40/.test(errDeck.msg)) fail('short deck should error');
console.log('short deck rejected OK');

// valid decks
A.send({ t: 'deck', cards: aggroDeck() });
B.send({ t: 'deck', cards: aggroDeck() });
async function awaitLobby(client, pred) {
  for (;;) { const l = await client.next('lobby'); if (pred(l)) return l; }
}
await awaitLobby(A, l => l.hasDeck[0] && l.hasDeck[1]);
await awaitLobby(B, l => l.hasDeck[0] && l.hasDeck[1]);

// host changes timer
A.send({ t: 'settings', minutes: 10 });
const lob = await awaitLobby(A, l => l.settings.minutes === 10);
console.log('settings OK');

// ready up with opposite order picks -> deterministic order
A.send({ t: 'ready', order: 'first' });
B.send({ t: 'ready', order: 'second' });
console.log('both ready, match starting');

// play until over
function chooseAction(snap, roomSeat) {
  const mi = snap.seats.indexOf(roomSeat);
  if (snap.winner || snap.currentSeat !== mi) return null;
  const you = snap.you;
  // prefer damaging cards, highest cost affordable
  const playable = you.hand
    .map((id, i) => ({ id, i, c: CARDS[id] }))
    .filter(x => x.c.cost <= you.pips);
  const dmg = playable.filter(x => x.c.kind === 'hit' || x.c.kind === 'dot')
    .sort((a, b) => b.c.cost - a.c.cost);
  if (dmg.length) return { type: 'play', hand: dmg[0].i };
  if (playable.length) return { type: 'play', hand: playable[0].i };
  return { type: 'pass' };
}

async function drive(client, roomSeat, tag) {
  for (;;) {
    const m = await client.next('state', 15000);
    const action = chooseAction(m.snap, roomSeat);
    if (!action) {
      // not our turn or game over; keep consuming states until over arrives
      if (m.snap.winner) return m;
      continue;
    }
    client.send({ t: 'action', action });
  }
}

const [endA, endB] = await Promise.all([drive(A, 0, 'A'), drive(B, 1, 'B')]);
const overA = await A.next('over', 15000);
const overB = await B.next('over', 15000);
console.log('game over:', overA.winner, '/', overB.winner, `(${overA.reason})`);
if (!['you', 'foe', 'draw'].includes(overA.winner)) fail('bad winner');
if (!endA.snap.winner) fail('final snap missing winner');

// state filtering: B's hand hidden from A
const lastState = endA;
if (Array.isArray(lastState.snap.foe.hand)) fail('foe hand leaked!');
if (typeof lastState.snap.you.hand.length !== 'number') fail('own hand missing');
console.log('hand privacy OK');

// rematch resets to build phase
A.send({ t: 'rematch' });
const lob2 = await awaitLobby(A, l => l.phase === 'build' && !l.ready[0] && !l.ready[1]);
console.log('rematch OK');

console.log('E2E PASS');
process.exit(0);
