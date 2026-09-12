// Engine unit tests: node --test test/engine.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, applyAction, validateDeck } from '../shared/engine.js';
import { RULES } from '../shared/cards.js';

function deckOf(...ids) {
  const d = [...ids];
  while (d.length < 40) d.push('spark');
  return d;
}
// A genuinely valid 40-card deck (4-copy limit respected).
function validDeck() {
  const ids = ['spark', 'bolt', 'strike', 'blast', 'cataclysm', 'jab', 'hook', 'lash', 'sunder', 'shield'];
  return ids.flatMap(id => [id, id, id, id]);
}
function playByName(st, si, name) {
  const i = st.players[si].hand.findIndex(id => id === name);
  assert.notEqual(i, -1, `card ${name} in hand`);
  const r = applyAction(st, si, { type: 'play', hand: i });
  assert.ok(!r.error, r.error);
  return r;
}
function pass(st, si) {
  const r = applyAction(st, si, { type: 'pass' });
  assert.ok(!r.error, r.error);
}
function give(st, si, id) { st.players[si].hand.push(id); st.players[si].pips = 14; }

describe('setup', () => {
  it('starting hands, pips, turn order', () => {
    const { state } = createMatch([deckOf(), deckOf()], 0);
    assert.equal(state.players[0].hand.length, 7); // starting hand, no draw on turn 1
    assert.equal(state.players[1].hand.length, 7);
    assert.equal(state.players[0].pips, 5); // first player starts with 5
    assert.equal(state.players[1].pips, 7); // second player starts with 7
    assert.equal(state.current, 0);
  });
  it('negotiated second-player bonus pips', () => {
    const m0 = createMatch([deckOf(), deckOf()], 0, 0);
    assert.equal(m0.state.players[0].pips, 5);
    assert.equal(m0.state.players[1].pips, 5); // +0 bonus
    const m4 = createMatch([deckOf(), deckOf()], 1, 4);
    assert.equal(m4.state.players[0].pips, 5);
    assert.equal(m4.state.players[1].pips, 9); // +4 bonus
    assert.equal(m4.events[0].k, 'start');
    assert.equal(m4.events[0].p2bonus, 4); // start event carries the bonus
    const mClamped = createMatch([deckOf(), deckOf()], 0, 99);
    assert.equal(mClamped.state.players[1].pips, 5 + RULES.p2bonusMax); // clamped
  });
  it('deck validation', () => {
    assert.match(validateDeck(validDeck().slice(0, 39)), /at least 40/);
    assert.match(validateDeck([...Array(5).fill('spark'), ...validDeck().slice(0, 35)]), /more than 4/);
    assert.match(validateDeck(['nope', ...validDeck().slice(0, 39)]), /Unknown card/);
    assert.equal(validateDeck(validDeck()), null);
  });
});

describe('damage math', () => {
  it('spark: 210 * 2.5 * 0.8 = 420', () => {
    const { state } = createMatch([deckOf('spark'), deckOf()], 0);
    playByName(state, 0, 'spark');
    assert.equal(state.players[1].hp, 10000 - 420);
  });
  it('Shield: one shield per hit, pierceable (336)', () => {
    // room seat 1 (tower deck) moves first -> players[0]
    const { state } = createMatch([deckOf('spark'), deckOf('shield')], 1);
    playByName(state, 0, 'shield');
    assert.equal(state.players[0].shields.length, 1);
    playByName(state, 1, 'spark'); // 210*2.5*0.8*0.8 = 336
    assert.equal(state.players[0].hp, 10000 - 336);
    assert.equal(state.players[0].shields.length, 0);
  });
  it('two shields: a hit uses exactly one', () => {
    // room seat 1 (tower deck) moves first -> players[0]
    const { state } = createMatch([deckOf('spark'), deckOf('shield', 'shield')], 1);
    playByName(state, 0, 'shield');
    pass(state, 1);
    playByName(state, 0, 'shield');
    assert.equal(state.players[0].shields.length, 2);
    playByName(state, 1, 'spark');
    assert.equal(state.players[0].hp, 10000 - 336);
    assert.equal(state.players[0].shields.length, 1); // second shield survives
  });
  it('weakness scales the hit, then consumed', () => {
    const { state } = createMatch([deckOf('spark', 'spark'), deckOf('weakness')], 1);
    playByName(state, 0, 'weakness'); // room1 weakens room0 (players[1])
    assert.equal(state.players[1].weakness, 25);
    playByName(state, 1, 'spark'); // 210*2.5*0.75*0.8 = 315
    assert.equal(state.players[0].hp, 10000 - 315);
    assert.equal(state.players[1].weakness, null);
    pass(state, 0);
    playByName(state, 1, 'spark'); // back to 420
    assert.equal(state.players[0].hp, 10000 - 315 - 420);
  });
  it('blades stack and are consumed together', () => {
    const { state } = createMatch([deckOf('jab', 'blade', 'spark'), deckOf()], 0);
    playByName(state, 0, 'jab'); // 80*2.5*0.8=160, +25 blade after the hit
    assert.equal(state.players[1].hp, 10000 - 160);
    pass(state, 1);
    playByName(state, 0, 'blade'); // +35 blade
    pass(state, 1);
    playByName(state, 0, 'spark'); // 210*(1+1.5+.25+.35)*0.8 = 521
    assert.equal(state.players[1].hp, 10000 - 160 - 521);
    assert.deepEqual(state.players[0].blades, []);
  });
});

describe('DoTs', () => {
  it('weakness scales the whole DoT (upfront + ticks)', () => {
    const { state } = createMatch([deckOf('smolder'), deckOf('weakness')], 1);
    playByName(state, 0, 'weakness'); // players[1] gets -25%
    playByName(state, 1, 'smolder');
    // upfront 180 + first tick fires immediately (foe's turn starts next): 105
    assert.equal(state.players[0].hp, 10000 - 180 - 105);
    pass(state, 0);
    pass(state, 1); // second tick on players[0]'s next turn
    assert.equal(state.players[0].hp, 10000 - 180 - 105 - 105);
  });
  it('ticks use shields when present, one per tick', () => {
    const { state } = createMatch([deckOf('smolder'), deckOf('shield')], 0);
    playByName(state, 0, 'smolder'); // upfront 240 + immediate tick 140
    assert.equal(state.players[1].hp, 10000 - 240 - 140);
    playByName(state, 1, 'shield');
    pass(state, 0); // tick: 175*0.8*0.8=112, shield consumed
    assert.equal(state.players[1].hp, 10000 - 240 - 140 - 112);
    assert.equal(state.players[1].shields.length, 0);
    pass(state, 1);
    pass(state, 0); // next tick: 175*0.8=140, no shield
    assert.equal(state.players[1].hp, 10000 - 240 - 140 - 112 - 140);
  });
});

describe('turn structure', () => {
  it('redraw keeps hand size and draws in deck order', () => {
    const d = deckOf('spark', 'bolt', 'strike', 'blast', 'cataclysm', 'jab', 'hook');
    const { state } = createMatch([d, deckOf()], 0);
    // starting hand: first 7 cards, no draw on turn 1
    const r = applyAction(state, 0, { type: 'redraw', hand: [0, 1, 2] });
    assert.ok(!r.error);
    assert.equal(state.players[0].hand.length, 7);
    assert.deepEqual(state.players[0].hand.slice(0, 4), ['blast', 'cataclysm', 'jab', 'hook']);
    assert.deepEqual(state.players[0].hand.slice(4), ['spark', 'spark', 'spark']); // next 3 in order
    assert.equal(state.current, 1); // turn passed
  });
  it('pips capped at 14', () => {
    const { state } = createMatch([deckOf(), deckOf()], 0);
    for (let i = 0; i < 20; i++) pass(state, state.current);
    assert.ok(state.players[0].pips <= 14 && state.players[1].pips <= 14);
  });
  it('knockout ends the match', () => {
    const { state } = createMatch([deckOf('cataclysm'), deckOf()], 0);
    state.players[1].hp = 100;
    give(state, 0, 'cataclysm');
    playByName(state, 0, 'cataclysm');
    assert.equal(state.winner, 0);
    assert.equal(state.winReason, 'knockout');
  });
  it('HoT heals at turn start', () => {
    const { state } = createMatch([deckOf('mend'), deckOf()], 0);
    state.players[0].hp = 9000;
    playByName(state, 0, 'mend');
    pass(state, 1);
    pass(state, 0); // +120
    assert.equal(state.players[0].hp, 9120);
  });
});

describe('Empower', () => {
  it('sacrifices 5% max HP for 3 pips', () => {
    const { state } = createMatch([deckOf('empower'), deckOf()], 0);
    state.players[0].pips = 5;
    playByName(state, 0, 'empower');
    assert.equal(state.players[0].hp, 9500);
    assert.equal(state.players[0].pips, 8);
  });
  it('pips cap at 14', () => {
    const { state } = createMatch([deckOf('empower'), deckOf()], 0);
    state.players[0].pips = 13;
    playByName(state, 0, 'empower');
    assert.equal(state.players[0].pips, 14);
  });
  it('cannot be played at 500 HP or less', () => {
    const { state } = createMatch([deckOf('empower'), deckOf()], 0);
    state.players[0].hp = 500;
    const i = state.players[0].hand.findIndex(id => id === 'empower');
    const r = applyAction(state, 0, { type: 'play', hand: i });
    assert.ok(r.error);
    assert.equal(state.players[0].hp, 500); // untouched, card not consumed
    assert.ok(state.players[0].hand.includes('empower'));
  });
});

describe('Traps', () => {
  it('trap boosts the next incoming hit by 40%, then is consumed', () => {
    const { state } = createMatch([deckOf('trap', 'spark', 'spark'), deckOf()], 0);
    playByName(state, 0, 'trap');
    assert.deepEqual(state.players[1].traps, [40]);
    pass(state, 1);
    playByName(state, 0, 'spark'); // 420 x 1.4 = 588
    assert.equal(state.players[1].hp, 10000 - 588);
    assert.deepEqual(state.players[1].traps, []);
    pass(state, 1);
    playByName(state, 0, 'spark'); // no trap left: 420
    assert.equal(state.players[1].hp, 10000 - 588 - 420);
  });
  it('each DoT tick uses up one trap', () => {
    const { state } = createMatch([deckOf('smolder', 'trap'), deckOf()], 0);
    playByName(state, 0, 'smolder'); // 240 upfront, dot on foe
    pass(state, 1); // tick 140 (no trap yet)
    assert.equal(state.players[1].hp, 10000 - 240 - 140);
    playByName(state, 0, 'trap'); // trap on foe
    pass(state, 1); // tick 140 x 1.4 = 196, trap consumed
    assert.equal(state.players[1].hp, 10000 - 240 - 140 - 196);
    assert.deepEqual(state.players[1].traps, []);
  });
  it('ambush: 2000 upfront, trap lands for the next hit', () => {
    const { state } = createMatch([deckOf('ambush', 'spark'), deckOf()], 0);
    give(state, 0, 'ambush');
    playByName(state, 0, 'ambush'); // 1000 x 2.5 x 0.8 = 2000, trap NOT applied to itself
    assert.equal(state.players[1].hp, 8000);
    assert.deepEqual(state.players[1].traps, [40]);
    pass(state, 1);
    playByName(state, 0, 'spark'); // 420 x 1.4 = 588
    assert.equal(state.players[1].hp, 8000 - 588);
  });
});

describe('incoming auras, weakness aura, bubble', () => {
  it('expose overwrites brace: +20% incoming', () => {
    const { state } = createMatch([deckOf(), deckOf()], 0);
    give(state, 0, 'sunder'); playByName(state, 0, 'sunder'); // self brace
    assert.equal(state.players[0].inAura.v, -20);
    give(state, 1, 'expose'); playByName(state, 1, 'expose'); // overwrites brace
    assert.equal(state.players[0].inAura.v, 20);
    pass(state, 0);
    give(state, 1, 'spark'); playByName(state, 1, 'spark'); // 210*2.5*0.8*1.2 = 504
    assert.equal(state.players[0].hp, 10000 - 504);
  });
  it('sunder brace still reduces incoming (pierced by base 30 pierce)', () => {
    const { state } = createMatch([deckOf(), deckOf()], 0);
    give(state, 0, 'sunder'); playByName(state, 0, 'sunder');
    give(state, 1, 'spark'); playByName(state, 1, 'spark'); // 210*2.5*0.8*1.0 = 420
    assert.equal(state.players[0].hp, 10000 - 420);
  });
  it('wither: -15% weakness aura on enemy outgoing', () => {
    const { state } = createMatch([deckOf(), deckOf()], 0);
    give(state, 0, 'wither'); playByName(state, 0, 'wither');
    assert.equal(state.players[1].wAura.v, 15);
    give(state, 1, 'spark'); playByName(state, 1, 'spark'); // 210*2.5*0.8*0.85 = 357
    assert.equal(state.players[0].hp, 10000 - 357);
  });
  it('bubble: +25% for the setter, nothing for the other side', () => {
    const { state } = createMatch([deckOf(), deckOf()], 0);
    give(state, 0, 'bubble'); playByName(state, 0, 'bubble');
    assert.equal(state.bubble.owner, 0);
    pass(state, 1);
    give(state, 0, 'spark'); playByName(state, 0, 'spark'); // 210*2.5*0.8*1.25 = 525
    assert.equal(state.players[1].hp, 10000 - 525);
    give(state, 1, 'spark'); playByName(state, 1, 'spark'); // 420, no bubble for player 1
    assert.equal(state.players[0].hp, 10000 - 420);
  });
  it('surge: 200 damage and flips the bubble', () => {
    const { state } = createMatch([deckOf(), deckOf()], 0);
    give(state, 0, 'bubble'); playByName(state, 0, 'bubble');
    give(state, 1, 'surge'); playByName(state, 1, 'surge'); // 200*2.5*0.8 = 400
    assert.equal(state.players[0].hp, 10000 - 400);
    assert.equal(state.bubble.owner, 1);
  });
  it('bubble persists across turns (no timer)', () => {
    const { state } = createMatch([deckOf(), deckOf()], 0);
    give(state, 0, 'bubble'); playByName(state, 0, 'bubble');
    pass(state, 1); pass(state, 0); pass(state, 1); pass(state, 0);
    assert.equal(state.bubble.owner, 0);
  });
});
