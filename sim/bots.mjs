// Headless self-play harness: bots play full games via the real engine.
// Run: node sim/bots.mjs [gamesPerMatchup]
import { createMatch, applyAction } from '../shared/engine.js';
import { CARDS, RULES, validateDeck } from '../shared/cards.js';

const N = Number(process.argv[2] || 200);

function deckOf(entries) {
  const d = [];
  for (const [id, n] of entries) for (let i = 0; i < n; i++) d.push(id);
  return d;
}

// ---- test decks (40 cards each) ----
const DECKS = {
  aggro: deckOf([
    ['spark', 4], ['bolt', 4], ['strike', 4], ['jab', 4], ['blade', 4],
    ['hook', 4], ['lash', 4], ['shield', 4], ['trap', 4], ['pierce', 4],
  ]),
  dots: deckOf([
    ['smolder', 4], ['inferno', 4], ['trap', 4], ['pierce', 4], ['weakness', 4],
    ['shield', 4], ['spark', 4], ['bolt', 4], ['jab', 4], ['wither', 4],
  ]),
  turtle: deckOf([
    ['shield', 4], ['renew', 4], ['mend', 4], ['sunder', 4], ['expose', 4],
    ['weakness', 4], ['blast', 4], ['strike', 4], ['empower', 4], ['bubble', 4],
  ]),
  balanced: deckOf([
    ['spark', 4], ['bolt', 4], ['jab', 4], ['blade', 4], ['shield', 4],
    ['smolder', 4], ['trap', 4], ['hook', 4], ['lash', 4], ['renew', 4],
  ]),
};
for (const [k, d] of Object.entries(DECKS)) {
  const err = validateDeck(d);
  if (err) throw new Error(`deck ${k}: ${err}`);
}

const rnd = (n) => Math.floor(Math.random() * n);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---- bot policies ----
function legalPlays(state, si) {
  const p = state.players[si];
  const out = [];
  p.hand.forEach((id, i) => {
    const c = CARDS[id];
    if (p.pips < c.cost) return;
    if (c.kind === 'sacrifice' && p.hp <= Math.floor(RULES.maxHp * c.sacrificePct / 100)) return;
    out.push(i);
  });
  return out;
}

const POLICIES = {
  // random legal move
  random(state, si) {
    const plays = legalPlays(state, si);
    if (plays.length && Math.random() < 0.8) return { type: 'play', hand: plays[rnd(plays.length)] };
    return { type: 'pass' };
  },
  // maximize immediate damage per pip, simple survival instincts
  aggro(state, si) {
    const p = state.players[si];
    const plays = legalPlays(state, si);
    if (!plays.length) {
      // redraw dead expensive cards if nothing playable
      const dead = p.hand.map((id, i) => (CARDS[id].cost > p.pips + 4 ? i : -1)).filter(i => i >= 0);
      if (dead.length >= 2) return { type: 'redraw', hand: dead.slice(0, 3) };
      return { type: 'pass' };
    }
    let best = plays[0], bestScore = -1e9;
    for (const i of plays) {
      const c = CARDS[p.hand[i]];
      let s = 0;
      const dmg = (c.dmg || 0) + (c.tick || 0) * (c.ticks || 0);
      if (dmg) s = (dmg / Math.max(1, c.cost)) * 10;
      if (c.kind === 'blade') s = 55;
      if (c.kind === 'trap') s = 50;
      if (c.kind === 'pierce') s = p.blades.length ? 70 : 20;
      if (c.kind === 'shield') s = p.hp < 5000 ? 60 : 25;
      if (c.kind === 'hot') s = p.hp < 6000 ? 65 : 15;
      if (c.kind === 'weak') s = 45;
      if (c.kind === 'sacrifice') s = p.pips <= 4 ? 75 : 10;
      if (c.kind === 'bubble') s = 40;
      if (c.kind === 'expose' || c.kind === 'waura') s = 42;
      if (c.kind === 'aura') s = 48;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return { type: 'play', hand: best };
  },
  // turtle: defense first, chip damage
  turtle(state, si) {
    const p = state.players[si], foe = state.players[1 - si];
    const plays = legalPlays(state, si);
    if (!plays.length) return { type: 'pass' };
    let best = plays[0], bestScore = -1e9;
    for (const i of plays) {
      const c = CARDS[p.hand[i]];
      let s = 0;
      const dmg = (c.dmg || 0) + (c.tick || 0) * (c.ticks || 0);
      if (c.kind === 'shield') s = 90;
      else if (c.kind === 'hot') s = p.hp < 8000 ? 85 : 20;
      else if (c.kind === 'weak' || c.kind === 'waura') s = 70;
      else if (c.kind === 'expose') s = 65;
      else if (c.brace) s = 75;
      else if (c.kind === 'sacrifice') s = 30;
      else if (dmg) s = 30 + dmg / Math.max(1, c.cost);
      else s = 35;
      // don't waste shields into nothing
      if (c.kind === 'shield' && foe.dots.length === 0 && p.shields.length >= 2) s = 10;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return { type: 'play', hand: best };
  },
};

function playGame(deckA, deckB, polA, polB, firstSeat) {
  // shuffle decks like real draws would vary (engine draws in order; shuffle for variety)
  const { state } = createMatch([shuffle([...deckA]), shuffle([...deckB])], firstSeat);
  let turns = 0;
  const cardCounts = {};
  while (state.winner === null && turns < 400) {
    const si = state.current;
    const pol = si === 0 ? polA : polB;
    const action = pol(state, si);
    const { error, events } = applyAction(state, si, action);
    if (error) { applyAction(state, si, { type: 'pass' }); }
    else if (action.type === 'play') {
      const e = events.find(e => e.k === 'card');
      if (e) cardCounts[e.card] = (cardCounts[e.card] || 0) + 1;
    }
    turns++;
  }
  // attribute the win to the DECK, not the match-player index:
  // firstSeat=0 -> match player 0 holds deckA; firstSeat=1 -> match player 0 holds deckB
  let winnerDeck = 'draw';
  if (state.winner === 0) winnerDeck = firstSeat === 0 ? 'A' : 'B';
  else if (state.winner === 1) winnerDeck = firstSeat === 0 ? 'B' : 'A';
  return { winnerDeck, turns, cardCounts, capped: state.winner === null };
}

function matchup(nameA, nameB, polA, polB, n) {
  let wA = 0, wB = 0, draws = 0, capped = 0, turns = 0;
  let firstWins = 0;
  const cards = {};
  for (let i = 0; i < n; i++) {
    const first = i % 2; // alternate who moves first
    const r = playGame(DECKS[nameA], DECKS[nameB], polA, polB, first);
    turns += r.turns;
    if (r.winnerDeck === 'A') wA++; else if (r.winnerDeck === 'B') wB++; else draws++;
    if (r.capped) capped++;
    // did the first player win? first=0 -> deckA moves first
    if ((r.winnerDeck === 'A') === (first === 0) && r.winnerDeck !== 'draw') firstWins++;
    for (const [c, k] of Object.entries(r.cardCounts)) cards[c] = (cards[c] || 0) + k;
  }
  return { nameA, nameB, wA, wB, draws, capped, avgTurns: (turns / n).toFixed(1),
           firstWinPct: ((100 * firstWins) / Math.max(1, wA + wB)).toFixed(1), cards };
}

const MATCHUPS = [
  ['aggro', 'aggro'], ['aggro', 'dots'], ['aggro', 'turtle'], ['aggro', 'balanced'],
  ['dots', 'turtle'], ['dots', 'balanced'], ['turtle', 'balanced'],
];

console.log(`self-play: ${N} games per matchup, aggro policy both sides (alternating first player)\n`);
const results = [];
for (const [a, b] of MATCHUPS) {
  const r = matchup(a, b, POLICIES.aggro, POLICIES.aggro, N);
  results.push(r);
  const total = r.wA + r.wB + r.draws;
  console.log(
    `${a} vs ${b}: ${a} ${(100 * r.wA / total).toFixed(1)}% | ${b} ${(100 * r.wB / total).toFixed(1)}% | draws ${(100 * r.draws / total).toFixed(1)}% (capped ${r.capped}) | avg ${r.avgTurns} turns | 1st-player win ${r.firstWinPct}%`
  );
}
// policy sanity: aggro vs turtle-policy
console.log('');
for (const [a, b] of [['turtle', 'aggro']]) {
  const r = matchup(a, b, POLICIES.turtle, POLICIES.aggro, N);
  const total = r.wA + r.wB + r.draws;
  console.log(`turtle-policy(${a}) vs aggro-policy(${b}): ${a} ${(100 * r.wA / total).toFixed(1)}% | ${b} ${(100 * r.wB / total).toFixed(1)}% | avg ${r.avgTurns} turns`);
}
// most-played cards across all games
const all = {};
for (const r of results) for (const [c, k] of Object.entries(r.cards)) all[c] = (all[c] || 0) + k;
console.log('\nmost played cards:', Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, k]) => `${c}:${k}`).join(' '));
