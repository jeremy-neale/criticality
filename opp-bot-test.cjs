// Scripted opponent (player A / creator) for UI testing.
// Prints the room code, then drives: neg_ready -> deck -> ready -> auto-pass on its turns.
const WebSocket = require('ws');
const ids = ['spark', 'bolt', 'strike', 'blast', 'cataclysm', 'jab', 'hook', 'lash', 'sunder', 'ember'];
const deck = ids.flatMap(c => [c, c, c, c]);

const ws = new WebSocket('ws://localhost:18081');
let deckSent = false, lastPass = 0, mySeat = -1;

ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: 'Jarvis' })));
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.t === 'room') { mySeat = m.seat; console.log('CODE:' + m.code); }
  else if (m.t === 'lobby') {
    if (m.phase === 'lobby' && m.names[1] && m.neg && !m.neg.ready[0]) {
      ws.send(JSON.stringify({ t: 'neg_ready' }));
    }
    if (m.phase === 'build' && !deckSent) {
      deckSent = true;
      ws.send(JSON.stringify({ t: 'deck', cards: deck }));
      setTimeout(() => ws.send(JSON.stringify({ t: 'ready' })), 500);
    }
  } else if (m.t === 'state') {
    const s = m.snap;
    const me = s.seats.indexOf(mySeat);
    if (!s.winner && s.currentSeat === me && Date.now() - lastPass > 3000) {
      lastPass = Date.now();
      setTimeout(() => ws.send(JSON.stringify({ t: 'action', action: { type: 'pass' } })), 1200);
    }
  } else if (m.t === 'error') {
    console.log('SERVER ERROR: ' + m.msg);
  }
});
ws.on('close', () => { console.log('disconnected'); process.exit(0); });
// stay alive for the test
setTimeout(() => { console.log('test window over'); process.exit(0); }, 1000 * 60 * 8);
