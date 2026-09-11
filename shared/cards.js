// Shared card data + base rules.
// Used by the server (Node) and the browser client via ESM. Edit card numbers here.

export const RULES = {
  maxHp: 10000,
  dmgBonus: 1.5,      // +150% damage stat
  resist: 0.5,        // 50% resist stat
  basePierce: 30,     // 30 pierce stat
  pipStart: [5, 7],   // first player starts with 5 pips, second with 7
  pipPerTurn: 2,
  pipCap: 14,
  handStart: 7,       // first 7 cards of the deck = starting hand
  copiesMax: 4,       // max copies of one card per deck
  deckMin: 40,
  deckMax: 100,
  turnSecs: 30,
  defaultMatchMins: 15,
  auraRounds: 4,
  bubblePct: 25,      // arena-wide bubble: +25% damage to the spells of whoever set it last
};

export const CARDS = {
  // ---- pure damage: a hit for every even pip cost ----
  spark:    { name: 'Spark',     cost: 2,  kind: 'hit', dmg: 210,  text: '210 damage.' },
  bolt:     { name: 'Bolt',      cost: 4,  kind: 'hit', dmg: 440,  text: '440 damage.' },
  strike:   { name: 'Strike',    cost: 6,  kind: 'hit', dmg: 680,  text: '680 damage.' },
  blast:    { name: 'Blast',     cost: 8,  kind: 'hit', dmg: 950,  text: '950 damage.' },
  cataclysm:{ name: 'Cataclysm', cost: 10, kind: 'hit', dmg: 1200, text: '1200 damage.' },

  // ---- utility hits: odd pip costs ----
  jab:    { name: 'Jab',    cost: 1, kind: 'hit', dmg: 80,  blade: 25,
            text: '80 damage, +25% blade.' },
  hook:   { name: 'Hook',   cost: 3, kind: 'hit', dmg: 150, weakness: 15,
            text: '150 damage, \u221215% weakness.' },
  lash:   { name: 'Lash',   cost: 5, kind: 'hit', dmg: 320, outAura: 20,
            text: '320 damage, \u221220% outgoing aura.' },
  sunder: { name: 'Sunder', cost: 7, kind: 'hit', dmg: 500, brace: 20,
            text: '500 damage, \u221220% brace.' },

  // ---- 0-pip utility ----
  shield:  { name: 'Shield',    cost: 0, kind: 'shield', shield: 50,
             text: '\u221250% shield.' },
  weakness:{ name: 'Weakness',  cost: 0, kind: 'weak', weakness: 25,
             text: '\u221225% weakness.' },
  blade:   { name: 'Blade',     cost: 0, kind: 'blade', blade: 35,
             text: '+35% blade.' },
  pierce:  { name: 'Piercing Edge', cost: 0, kind: 'pierce', pierce: 30,
             text: '+30 pierce.' },
  aura:    { name: 'Battle Aura',   cost: 0, kind: 'aura', outBuff: 25,
             text: '+25% outgoing aura.' },
  empower: { name: 'Empower',   cost: 0, kind: 'sacrifice', sacrificePct: 5, gainPips: 3,
             text: '\u22125% max HP, +3 pips.' },
  trap:    { name: 'Trap',      cost: 0, kind: 'trap', trap: 40,
             text: '+40% trap.' },

  // ---- hit + trap ----
  ambush:  { name: 'Ambush',    cost: 9, kind: 'hit', dmg: 1000, trap: 40,
             text: '1000 damage, +40% trap.' },

  // ---- damage over time ----
  smolder: { name: 'Smolder', cost: 3, kind: 'dot', dmg: 120, tick: 90, ticks: 3,
             text: '120 damage, then 90×3 DoT.' },
  inferno: { name: 'Inferno', cost: 6, kind: 'dot', dmg: 240, tick: 160, ticks: 4,
             text: '240 damage, then 160×4 DoT.' },

  // ---- healing over time ----
  mend:  { name: 'Mend',  cost: 2, kind: 'hot', tick: 120, ticks: 3,
           text: '120×3 HoT.' },
  renew: { name: 'Renew', cost: 4, kind: 'hot', tick: 250, ticks: 3,
           text: '250×3 HoT.' },
  expose: { name: 'Expose', cost: 0, kind: 'expose', inAura: 20,
            text: '+20% incoming aura.' },
  wither: { name: 'Wither', cost: 0, kind: 'waura', wAura: 15,
            text: '−15% weakness aura.' },
  bubble: { name: 'Bubble', cost: 2, kind: 'bubble',
            text: 'Set the bubble: +25% damage for your spells.' },
  surge: { name: 'Surge', cost: 4, kind: 'hit', dmg: 200, bubble: true,
           text: '200 damage, set the bubble.' },
};

export const CARD_IDS = Object.keys(CARDS);

// Answer-key glossary: keyword -> explanation. Card text highlights these words;
// clicking one opens the key drawer and jumps to the entry.
export const GLOSSARY = {
  blade:    { name: 'Blade', text: '+X% damage on your next damaging hit. Blades stack; all are consumed together by that hit.' },
  trap:     { name: 'Trap', text: 'Sits on the enemy: +X% to the next hit they take. Each damage instance (a hit or one DoT tick) uses up exactly one trap.' },
  shield:   { name: 'Shield', text: '−X% to one damage instance you take. Each hit or DoT tick uses up one shield. Pierceable.' },
  weakness: { name: 'Weakness', text: '−X% to the target\u2019s next outgoing hit, including all DoT ticks. Only one at a time; consumed on use. Cannot be pierced.' },
  pierce:   { name: 'Pierce', text: '+X pierce on your next damaging hit. Lowers the target\u2019s resist, shields and brace against that hit.' },
  aura:     { name: 'Aura', text: '±X% damage for 4 rounds. Outgoing auras change the damage you deal; incoming auras change the damage you take. A new aura refreshes the timer instead of stacking. An incoming aura overwrites brace, and brace overwrites it.' },
  brace:    { name: 'Brace', text: '\u2212X% incoming damage for 4 rounds. Overwritten by an incoming aura like Expose. Pierceable.' },
  DoT:      { name: 'DoT', text: 'Damage over time: an upfront hit now, then one tick at the start of the enemy\u2019s next N turns. Each tick hits into their current resist, brace, one shield and one trap.' },
  HoT:      { name: 'HoT', text: 'Heal over time: heals you at the start of your next N turns.' },
  pips:     { name: 'Pips', text: 'The cost of cards. You gain 2 pips at the start of each of your turns, up to 14.' },
  bubble:   { name: 'Bubble', text: 'A single arena-wide bubble worth +25% damage to the spells of whoever set it last. It stays until someone changes it \u2014 there is no timer.' },
};

// Effective largest deck with the 4-copy limit (84 with the current 21 cards).
export const EFFECTIVE_DECK_MAX = CARD_IDS.length * RULES.copiesMax;

export function validateDeck(deck) {
  if (!Array.isArray(deck)) return 'Deck must be a list of cards.';
  if (deck.length < RULES.deckMin) return `Deck needs at least ${RULES.deckMin} cards (has ${deck.length}).`;
  if (deck.length > RULES.deckMax) return `Deck can have at most ${RULES.deckMax} cards.`;
  const counts = {};
  for (const id of deck) {
    if (!CARDS[id]) return `Unknown card: ${id}.`;
    counts[id] = (counts[id] || 0) + 1;
    if (counts[id] > RULES.copiesMax)
      return `"${CARDS[id].name}" appears more than ${RULES.copiesMax} times.`;
  }
  return null; // valid
}

// One-line rules summary for the library page / README.
export const RULES_SUMMARY = [
  `${RULES.maxHp.toLocaleString()} HP, +${RULES.dmgBonus * 100}% damage, ${RULES.resist * 100}% resist, ${RULES.basePierce} pierce. NO RNG.`,
  `First player starts with ${RULES.pipStart[0]} pips, second with ${RULES.pipStart[1]}. Gain ${RULES.pipPerTurn} pips at the start of each of your turns (cap ${RULES.pipCap}).`,
  `Decks are ${RULES.deckMin}-${RULES.deckMax} cards, max ${RULES.copiesMax} copies of each card. The first ${RULES.handStart} cards are your starting hand; the rest are drawn in order.`,
  `Each turn: draw 1 card, then one move — play a card, pass, or redraw (discard any number of cards, draw that many replacements). ${RULES.turnSecs}s per turn.`,
  `Damage = base x (1 + damage% + blades + outgoing aura) x (1 - weakness) x (1 - outgoing debuff) x (1 - max(0, resist - pierce)) x shields/brace (each pierceable) x (1 + traps on the target).`,
  `Traps sit on the target and boost the next hit they take (+40% each, additive). Each damage instance (a hit or one DoT tick) uses up exactly one trap.`,
  `Weakness (one at a time, on the hitter) scales the whole hit including DoT ticks, then is consumed. Cannot be pierced.`,
  `Shields queue up; each damage instance (a hit or one DoT tick) uses exactly one shield.`,
  `Auras last ${RULES.auraRounds} rounds and refresh instead of stacking. An incoming aura overwrites brace and vice versa.`,
  `Bubble: one arena-wide +${RULES.bubblePct}% damage bonus for the spells of whoever set it last. It stays until someone changes it.`,
];
