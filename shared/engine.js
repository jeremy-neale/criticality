// Deterministic duel engine. Pure logic, no I/O, no RNG.
// The server owns the state; the client only renders snapshots + event animations.

import { RULES, CARDS, validateDeck } from './cards.js';

export { validateDeck };

function newPlayer(deck) {
  return {
    hp: RULES.maxHp,
    pips: 0,
    hasStarted: false,   // set true after first turn begins (no +2 pips/draw on turn 1)
    hand: [],
    deck: [...deck],
    blades: [],          // e.g. [25, 35] — stack, all consumed on next damaging hit
    pierceBlade: false,  // +30 pierce on next damaging hit
    shields: [],         // queue of -50% shields; each damage instance uses one
    traps: [],           // queue of +% traps on this player; each damage instance taken uses one
    weakness: null,      // -% on next outgoing hit (whole hit incl. DoT), then consumed
    outAura: null,       // {v, rounds} -% outgoing damage debuff on this player
    wAura: null,         // {v, rounds} -% outgoing weakness aura on this player
    inAura: null,        // {v, rounds} signed incoming-damage aura: -v = brace, +v = exposed
    outBuff: null,       // {v, rounds} +% outgoing damage
    dots: [],            // [{tick, attMult, rounds}] damage over time on this player
    hots: [],            // [{heal, rounds}] healing over time on this player
    dotWard: 0,          // rounds of immunity to gaining new DoTs (from purify)
  };
}

// decks: [deckSeat0, deckSeat1]; seat 0 moves first.
export function createMatch(decks, firstSeat, p2Bonus = RULES.pipStart[1] - RULES.pipStart[0]) {
  const order = firstSeat === 0 ? [0, 1] : [1, 0];
  const players = [newPlayer(decks[order[0]]), newPlayer(decks[order[1]])];
  players[0].pips = RULES.pipStart[0];
  players[1].pips = RULES.pipStart[0] + Math.max(RULES.p2bonusMin, Math.min(RULES.p2bonusMax, Math.round(p2Bonus)));
  for (const p of players) {
    p.hand = p.deck.splice(0, RULES.handStart);
  }
  const state = {
    players,
    seats: order,          // seats[0] = room seat that moves first
    current: 0,            // index into players (0 = first player)
    turnNum: 1,
    bubble: null,          // {owner: playerIdx} — arena-wide +25% to the owner's spells until changed
    winner: null,          // null | 0 | 1 | 'draw'
    winReason: null,
  };
  const events = [{ k: 'start', first: order[0], p2bonus: players[1].pips - players[0].pips }];
  startTurn(state, events);
  return { state, events };
}

function attackerMult(p, bubbleFor) {
  let m = 1 + RULES.dmgBonus + p.blades.reduce((a, b) => a + b, 0) / 100;
  if (p.outBuff) m *= 1 + p.outBuff.v / 100;
  if (bubbleFor) m *= 1 + RULES.bubblePct / 100;
  if (p.weakness) m *= 1 - p.weakness / 100;
  if (p.outAura) m *= 1 - p.outAura.v / 100;
  if (p.wAura) m *= 1 - p.wAura.v / 100;
  return m;
}

// Defender-side multiplier for one damage instance. Consumes one shield if present.
function defenderMult(d, piercePct) {
  let m = 1 - Math.max(0, RULES.resist - piercePct / 100);
  let shieldUsed = null;
  if (d.shields.length) {
    shieldUsed = d.shields.shift();
    m *= 1 - Math.max(0, shieldUsed / 100 - piercePct / 100);
  }
  if (d.inAura) {
    // negative = brace (pierceable); positive = exposed (not pierceable)
    if (d.inAura.v < 0) m *= 1 - Math.max(0, -d.inAura.v / 100 - piercePct / 100);
    else m *= 1 + d.inAura.v / 100;
  }
  return { m, shieldUsed };
}

function consumeAttackerMods(p) {
  p.blades = [];
  p.pierceBlade = false;
  p.weakness = null;
}

// Target-side trap multiplier for one damage instance. Consumes one trap if present.
function trapMult(d) {
  let m = 1, trapUsed = null;
  if (d.traps.length) {
    trapUsed = d.traps.shift();
    m += trapUsed / 100;
  }
  return { m, trapUsed };
}

// Full hit: returns {dmg, attMult} and applies damage.
function strike(state, ai, di, base, events) {
  const att = state.players[ai], def = state.players[di];
  const pierce = RULES.basePierce + (att.pierceBlade ? 30 : 0);
  const am = attackerMult(att, state.bubble && state.bubble.owner === ai);
  const { m: dm, shieldUsed } = defenderMult(def, pierce);
  const { m: tm, trapUsed } = trapMult(def);
  const dmg = Math.max(0, Math.round(base * am * dm * tm));
  consumeAttackerMods(att);
  def.hp = Math.max(0, def.hp - dmg);
  events.push({ k: 'dmg', to: di, from: ai, amount: dmg, shieldUsed, trapUsed });
  checkDeath(state, events);
  return { dmg, attMult: am };
}

function checkDeath(state, events) {
  if (state.winner !== null) return;
  const [a, b] = state.players;
  if (a.hp <= 0 && b.hp <= 0) { state.winner = 'draw'; }
  else if (a.hp <= 0) { state.winner = 1; }
  else if (b.hp <= 0) { state.winner = 0; }
  if (state.winner !== null) {
    state.winReason = 'knockout';
    events.push({ k: 'over', winner: state.winner });
  }
}

function drawCard(p, events, si) {
  if (p.deck.length) {
    const c = p.deck.shift();
    p.hand.push(c);
    if (events) events.push({ k: 'draw', to: si });
  }
}

function tickAuras(p) {
  for (const key of ['inAura', 'wAura', 'outBuff', 'outAura']) {
    const a = p[key];
    if (a && --a.rounds <= 0) p[key] = null;
  }
}

function startTurn(state, events) {
  const si = state.current;
  const p = state.players[si];
  events.push({ k: 'turn', seat: si, turnNum: state.turnNum });

  // Each player's first turn uses their starting pips/hand as dealt; the +2
  // pips and card draw apply from each player's second turn onward.
  if (p.hasStarted) {
    p.pips = Math.min(RULES.pipCap, p.pips + RULES.pipPerTurn);
    drawCard(p, events, si);
  }
  p.hasStarted = true;

  // HoTs tick at the start of your turn.
  for (const h of p.hots) {
    const amt = Math.min(RULES.maxHp - p.hp, h.heal);
    if (amt > 0) { p.hp += amt; events.push({ k: 'heal', to: si, amount: amt }); }
    h.rounds--;
  }
  p.hots = p.hots.filter(h => h.rounds > 0);

  // DoT ticks hit into your CURRENT defenses (resist, incoming aura, one shield each)
  // and consume one trap each if any are on you.
  for (const d of p.dots) {
    const { m: dm, shieldUsed } = defenderMult(p, RULES.basePierce);
    const { m: tm, trapUsed } = trapMult(p);
    const dmg = Math.max(0, Math.round(d.tick * d.attMult * dm * tm));
    p.hp = Math.max(0, p.hp - dmg);
    events.push({ k: 'dmg', to: si, from: 1 - si, amount: dmg, shieldUsed, trapUsed, dot: true });
    d.rounds--;
    checkDeath(state, events);
    if (state.winner) return;
  }
  p.dots = p.dots.filter(d => d.rounds > 0);

  if (p.dotWard > 0) p.dotWard--;

  tickAuras(p);
}

// Applies one of: {type:'play', hand:index} | {type:'pass'} | {type:'redraw', hand:[indices]}
// Returns {events} or {error}.
export function applyAction(state, si, action) {
  const events = [];
  if (state.winner !== null) return { error: 'Match is over.' };
  if (si !== state.current) return { error: 'Not your turn.' };
  const me = state.players[si], foe = state.players[1 - si];

  if (action.type === 'pass') {
    events.push({ k: 'pass', seat: si });
  } else if (action.type === 'redraw') {
    const idx = [...new Set(action.hand)].filter(i => Number.isInteger(i) && i >= 0 && i < me.hand.length)
      .sort((a, b) => b - a);
    if (!idx.length) return { error: 'Select at least one card to redraw.' };
    const discarded = idx.map(i => me.hand.splice(i, 1)[0]);
    events.push({ k: 'redraw', seat: si, count: discarded.length });
    for (let n = 0; n < discarded.length && me.deck.length; n++) {
      me.hand.push(me.deck.shift());
    }
    events.push({ k: 'draw', to: si, count: discarded.length });
  } else if (action.type === 'play') {
    const hi = action.hand;
    if (!Number.isInteger(hi) || hi < 0 || hi >= me.hand.length) return { error: 'Bad card.' };
    const id = me.hand[hi];
    const card = CARDS[id];
    if (!card) return { error: 'Unknown card.' };
    if (me.pips < card.cost) return { error: 'Not enough pips.' };
    if (card.kind === 'sacrifice') {
      const sac = Math.floor(RULES.maxHp * card.sacrificePct / 100);
      if (me.hp <= sac) return { error: 'Not enough health to Empower.' };
    }
    me.pips -= card.cost;
    me.hand.splice(hi, 1);
    events.push({ k: 'card', seat: si, card: id });

    switch (card.kind) {
      case 'hit': {
        if (card.shieldBreak) {
          const broken = foe.shields.splice(0, card.shieldBreak).length;
          if (broken) events.push({ k: 'shatter', to: 1 - si, count: broken });
        }
        let totalDmg = 0, attMult = 1;
        const nHits = card.hits || 1;
        for (let h = 0; h < nHits && state.winner === null; h++) {
          const r = strike(state, si, 1 - si, card.dmg, events);
          totalDmg += r.dmg;
          if (h === 0) attMult = r.attMult;
        }
        if (card.lifesteal && totalDmg > 0) {
          const amt = Math.min(RULES.maxHp - me.hp, Math.round(totalDmg * card.lifesteal / 100));
          if (amt > 0) { me.hp += amt; events.push({ k: 'heal', to: si, amount: amt }); }
        }
        if (card.stealPips) {
          const stolen = Math.min(foe.pips, card.stealPips);
          if (stolen > 0) {
            foe.pips -= stolen;
            me.pips = Math.min(RULES.pipCap, me.pips + stolen);
            events.push({ k: 'steal', to: 1 - si, from: si, pips: stolen });
          }
        }
        if (card.tick) {
          if (foe.dotWard > 0) {
            events.push({ k: 'warded', to: 1 - si });
          } else {
            foe.dots.push({ tick: card.tick, attMult, rounds: card.ticks });
            events.push({ k: 'dot', to: 1 - si, tick: card.tick, rounds: card.ticks });
          }
        }
        if (card.blade) { me.blades.push(card.blade); events.push({ k: 'blade', to: si, v: card.blade }); }
        // NOTE: blades from the hit itself apply AFTER the hit (next damaging hit).
        if (card.weakness) { foe.weakness = card.weakness; events.push({ k: 'weak', to: 1 - si, v: card.weakness }); }
        if (card.trap) { foe.traps.push(card.trap); events.push({ k: 'trap', to: 1 - si, v: card.trap }); }
        if (card.outAura) { foe.outAura = { v: card.outAura, rounds: RULES.auraRounds }; events.push({ k: 'outAura', to: 1 - si, v: card.outAura }); }
        if (card.brace) { me.inAura = { v: -card.brace, rounds: RULES.auraRounds }; events.push({ k: 'brace', to: si, v: card.brace }); }
        if (card.wAura) { foe.wAura = { v: card.wAura, rounds: RULES.auraRounds }; events.push({ k: 'wAura', to: 1 - si, v: card.wAura }); }
        if (card.bubble) { state.bubble = { owner: si }; events.push({ k: 'bubble', seat: si }); }
        break;
      }
      case 'dot': {
        const { attMult } = strike(state, si, 1 - si, card.dmg, events);
        if (foe.dotWard > 0) {
          events.push({ k: 'warded', to: 1 - si });
        } else {
          foe.dots.push({ tick: card.tick, attMult, rounds: card.ticks });
          events.push({ k: 'dot', to: 1 - si, tick: card.tick, rounds: card.ticks });
        }
        break;
      }
      case 'hot': {
        me.hots.push({ heal: card.tick, rounds: card.ticks });
        events.push({ k: 'hot', to: si, heal: card.tick, rounds: card.ticks });
        break;
      }
      case 'shield':
        me.shields.push(card.shield);
        events.push({ k: 'shield', to: si, v: card.shield });
        break;
      case 'blade':
        me.blades.push(card.blade);
        events.push({ k: 'blade', to: si, v: card.blade });
        break;
      case 'weak':
        foe.weakness = card.weakness;
        events.push({ k: 'weak', to: 1 - si, v: card.weakness });
        break;
      case 'trap':
        foe.traps.push(card.trap);
        events.push({ k: 'trap', to: 1 - si, v: card.trap });
        break;
      case 'pierce':
        me.pierceBlade = true;
        events.push({ k: 'pierceBlade', to: si });
        break;
      case 'aura':
        me.outBuff = { v: card.outBuff, rounds: RULES.auraRounds };
        events.push({ k: 'outBuff', to: si, v: card.outBuff });
        break;
      case 'expose':
        // overwrites brace (same incoming-aura slot)
        foe.inAura = { v: card.inAura, rounds: RULES.auraRounds };
        events.push({ k: 'expose', to: 1 - si, v: card.inAura });
        break;
      case 'waura':
        foe.wAura = { v: card.wAura, rounds: RULES.auraRounds };
        events.push({ k: 'wAura', to: 1 - si, v: card.wAura });
        break;
      case 'bubble':
        state.bubble = { owner: si };
        events.push({ k: 'bubble', seat: si });
        break;
      case 'sacrifice': {
        const sac = Math.floor(RULES.maxHp * card.sacrificePct / 100);
        me.hp -= sac;
        me.pips = Math.min(RULES.pipCap, me.pips + card.gainPips);
        events.push({ k: 'sacrifice', to: si, hp: sac, pips: card.gainPips });
        break;
      }
      case 'cleanse': {
        const n = me.dots.length;
        me.dots = [];
        const amt = Math.min(RULES.maxHp - me.hp, n * card.healPerDot);
        if (amt > 0) { me.hp += amt; events.push({ k: 'heal', to: si, amount: amt }); }
        if (card.wardRounds) me.dotWard = card.wardRounds;
        events.push({ k: 'cleanse', to: si, count: n });
        break;
      }
      default:
        return { error: 'Unknown card kind.' };
    }
  } else {
    return { error: 'Unknown action.' };
  }

  if (state.winner === null) {
    state.current = 1 - state.current;
    state.turnNum++;
    startTurn(state, events);
  }
  return { events };
}

// Per-seat filtered snapshot for the client.
export function snapshot(state, seatIdx) {
  const me = state.players[seatIdx], foe = state.players[1 - seatIdx];
  const pub = (p, own) => ({
    hp: p.hp, pips: p.pips,
    hand: own ? p.hand : p.hand.length,
    deckCount: p.deck.length,
    deckNext: own ? p.deck.slice(0, 1) : undefined,
    blades: [...p.blades],
    pierceBlade: p.pierceBlade,
    shields: p.shields.length,
    traps: [...p.traps],
    weakness: p.weakness,
    outAura: p.outAura ? { ...p.outAura } : null,
    wAura: p.wAura ? { ...p.wAura } : null,
    inAura: p.inAura ? { ...p.inAura } : null,
    outBuff: p.outBuff ? { ...p.outBuff } : null,
    dots: p.dots.map(d => ({ tick: Math.round(d.tick * d.attMult), rounds: d.rounds })),
    hots: p.hots.map(h => ({ ...h })),
  });
  return {
    you: pub(me, true),
    foe: pub(foe, false),
    bubble: state.bubble ? { owner: state.bubble.owner === seatIdx ? 'you' : 'foe' } : null,
    current: state.current === seatIdx ? 'you' : 'foe',
    currentSeat: state.current,
    seats: state.seats,
    turnNum: state.turnNum,
    winner: state.winner === null ? null : (state.winner === 'draw' ? 'draw' : (state.winner === seatIdx ? 'you' : 'foe')),
    winReason: state.winReason,
  };
}
