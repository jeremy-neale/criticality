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
    aura: null,          // ONE aura slot per player: {kind, v, rounds}. A new aura
                         // replaces whatever is there. kind: 'outBuff' (+% outgoing),
                         // 'outDebuff' (-% outgoing), 'weakAura' (-% outgoing weakness),
                         // 'inAura' (signed incoming: -v = brace, +v = exposed)
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

// One aura slot per player: applying a new aura replaces the old one.
// Returns the replaced aura (or null) so callers can report it.
function setAura(p, kind, v) {
  const old = p.aura;
  p.aura = { kind, v, rounds: RULES.auraRounds };
  return old;
}

function attackerMult(p, bubbleFor) {
  let m = 1 + RULES.dmgBonus + p.blades.reduce((a, b) => a + b, 0) / 100;
  // Ordered list of the visible modifiers, for the card-play showcase.
  // side 'up' = damage increased (card grows), 'down' = decreased (shrinks).
  const mods = [];
  if (p.blades.length) {
    const x = 1 + p.blades.reduce((a, b) => a + b, 0) / 100;
    mods.push({ label: p.blades.length > 1 ? 'blades' : 'blade', mult: x, side: 'up' });
  }
  const A = p.aura;
  if (A && A.kind === 'outBuff') { const x = 1 + A.v / 100; m *= x; mods.push({ label: 'aura', mult: x, side: 'up' }); }
  if (bubbleFor) { const x = 1 + RULES.bubblePct / 100; m *= x; mods.push({ label: 'bubble', mult: x, side: 'up' }); }
  if (p.weakness) { const x = 1 - p.weakness / 100; m *= x; mods.push({ label: 'weakness', mult: x, side: 'down' }); }
  if (A && A.kind === 'outDebuff') { const x = 1 - A.v / 100; m *= x; mods.push({ label: 'aura', mult: x, side: 'down' }); }
  if (A && A.kind === 'weakAura') { const x = 1 - A.v / 100; m *= x; mods.push({ label: 'wither', mult: x, side: 'down' }); }
  return { m, mods };
}

// Defender-side multiplier for one damage instance. Consumes one shield if present.
function defenderMult(d, piercePct) {
  const mods = [];
  let m = 1 - Math.max(0, RULES.resist - piercePct / 100);
  let shieldUsed = null;
  if (d.shields.length) {
    shieldUsed = d.shields.shift();
    const x = 1 - Math.max(0, shieldUsed / 100 - piercePct / 100);
    m *= x;
    mods.push({ label: 'shield', mult: x, side: 'down' });
  }
  const A = d.aura;
  if (A && A.kind === 'inAura') {
    // negative = brace (pierceable); positive = exposed (not pierceable)
    if (A.v < 0) { const x = 1 - Math.max(0, -A.v / 100 - piercePct / 100); m *= x; mods.push({ label: 'brace', mult: x, side: 'down' }); }
    else { const x = 1 + A.v / 100; m *= x; mods.push({ label: 'exposed', mult: x, side: 'up' }); }
  }
  return { m, shieldUsed, mods };
}

function consumeAttackerMods(p) {
  p.blades = [];
  p.pierceBlade = false;
  p.weakness = null;
}

// Target-side trap multiplier for one damage instance. Consumes one trap if present.
function trapMult(d) {
  let m = 1, trapUsed = null;
  const mods = [];
  if (d.traps.length) {
    trapUsed = d.traps.shift();
    m += trapUsed / 100;
    mods.push({ label: 'trap', mult: m, side: 'up' });
  }
  return { m, trapUsed, mods };
}

// Full hit: returns {dmg, attMult} and applies damage.
function strike(state, ai, di, base, events) {
  const att = state.players[ai], def = state.players[di];
  const pierce = RULES.basePierce + (att.pierceBlade ? 30 : 0);
  const { m: am, mods: amods } = attackerMult(att, state.bubble && state.bubble.owner === ai);
  const { m: dm, shieldUsed, mods: dmods } = defenderMult(def, pierce);
  const { m: tm, trapUsed, mods: tmods } = trapMult(def);
  const dmg = Math.max(0, Math.round(base * am * dm * tm));
  consumeAttackerMods(att);
  def.hp = Math.max(0, def.hp - dmg);
  events.push({ k: 'dmg', to: di, from: ai, amount: dmg, shieldUsed, trapUsed, mods: [...amods, ...dmods, ...tmods] });
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
  const a = p.aura;
  if (a && --a.rounds <= 0) p.aura = null;
}

function startTurn(state, events) {
  const si = state.current;
  const p = state.players[si];
  events.push({ k: 'turn', seat: si, turnNum: state.turnNum });

  // Each player's first turn uses their starting pips as dealt; the +2
  // pips apply from each player's second turn onward. Card draw happens at
  // the end of each turn (hand refills to 7), never at the start.
  if (p.hasStarted) {
    p.pips = Math.min(RULES.pipCap, p.pips + RULES.pipPerTurn);
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
    const { m: dm, shieldUsed, mods: dmods } = defenderMult(p, RULES.basePierce);
    const { m: tm, trapUsed, mods: tmods } = trapMult(p);
    const dmg = Math.max(0, Math.round(d.tick * d.attMult * dm * tm));
    p.hp = Math.max(0, p.hp - dmg);
    events.push({ k: 'dmg', to: si, from: 1 - si, amount: dmg, shieldUsed, trapUsed, dot: true, mods: [...dmods, ...tmods] });
    d.rounds--;
    checkDeath(state, events);
    if (state.winner) return;
  }
  p.dots = p.dots.filter(d => d.rounds > 0);

  if (p.dotWard > 0) p.dotWard--;

  tickAuras(p);
}

// Applies one of: {type:'play', hand:index} | {type:'pass'} | {type:'discard', hand:[indices]}
// Discarding is free: it never ends the turn and draws nothing. You can
// discard any number of cards and still play or pass afterwards.
// Play and pass end the turn: the hand refills to 7 at the end of the turn.
// Returns {events} or {error}.
export function applyAction(state, si, action) {
  const events = [];
  if (state.winner !== null) return { error: 'Match is over.' };
  if (si !== state.current) return { error: 'Not your turn.' };
  const me = state.players[si], foe = state.players[1 - si];

  if (action.type === 'pass') {
    events.push({ k: 'pass', seat: si });
  } else if (action.type === 'discard') {
    const idx = [...new Set(action.hand)].filter(i => Number.isInteger(i) && i >= 0 && i < me.hand.length)
      .sort((a, b) => b - a);
    if (!idx.length) return { error: 'Select at least one card to discard.' };
    const discarded = idx.map(i => me.hand.splice(i, 1)[0]);
    events.push({ k: 'discard', seat: si, count: discarded.length });
    // No immediate draw: the hand refills to 7 at the end of the turn.
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
        if (card.outAura) { const old = setAura(foe, 'outDebuff', card.outAura); events.push({ k: 'outAura', to: 1 - si, v: card.outAura, replaced: old ? old.kind : null }); }
        if (card.brace) { const old = setAura(me, 'inAura', -card.brace); events.push({ k: 'brace', to: si, v: card.brace, replaced: old ? old.kind : null }); }
        if (card.wAura) { const old = setAura(foe, 'weakAura', card.wAura); events.push({ k: 'wAura', to: 1 - si, v: card.wAura, replaced: old ? old.kind : null }); }
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
      case 'aura': {
        const old = setAura(me, 'outBuff', card.outBuff);
        events.push({ k: 'outBuff', to: si, v: card.outBuff, replaced: old ? old.kind : null });
        break;
      }
      case 'expose': {
        // one aura slot: replaces whatever aura the target had
        const old = setAura(foe, 'inAura', card.inAura);
        events.push({ k: 'expose', to: 1 - si, v: card.inAura, replaced: old ? old.kind : null });
        break;
      }
      case 'waura': {
        const old = setAura(foe, 'weakAura', card.wAura);
        events.push({ k: 'wAura', to: 1 - si, v: card.wAura, replaced: old ? old.kind : null });
        break;
      }
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

  if (state.winner === null && (action.type === 'play' || action.type === 'pass')) {
    // End of turn: refill the hand that just acted back up to 7 (or as many
    // as the deck has left). Hands never exceed 7. Discarding never ends
    // the turn, so the player can keep discarding and then play or pass.
    while (me.hand.length < RULES.handStart && me.deck.length) drawCard(me, events, si);
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
    aura: p.aura ? { ...p.aura } : null,
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
