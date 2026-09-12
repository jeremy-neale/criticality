import { CARDS, validateDeck } from './cards.js';

const x4 = (...ids) => ids.flatMap((id) => [id, id, id, id]);
const x3 = (...ids) => ids.flatMap((id) => [id, id, id]);
const x2 = (...ids) => ids.flatMap((id) => [id, id]);
const x1 = (...ids) => ids;

export const PRESETS = [
  {
    id: 'aggro',
    name: 'Aggro Burn',
    desc: 'All-out aggression: cheap efficient hits, blades to stack damage, and Empower to ramp pips faster.',
    cards: [
      ...x4('spark', 'bolt', 'jab', 'shatter'),
      ...x3('strike', 'hook', 'smolder', 'blade', 'empower'),
      ...x2('twinfang', 'sunder', 'pierce', 'ember'),
      'siphon',
    ],
  },
  {
    id: 'dots',
    name: 'DoT Pressure',
    desc: 'Wear the opponent down with damage-over-time, traps that punish each tick, and auras that keep the pressure on.',
    cards: [
      ...x4('smolder', 'trap', 'wither'),
      ...x3('inferno', 'cinder', 'hook', 'jab', 'blade', 'mend', 'spark', 'shatter'),
      ...x2('bubble'),
      'ambush', 'pierce',
    ],
  },
  {
    id: 'turtle',
    name: 'Turtle Control',
    desc: 'Outlast everything: shields, heals, and defensive auras, with Sunder and Strike to close out the game.',
    cards: [
      ...x4('weakness', 'mend'),
      ...x3('shield', 'sunder', 'expose', 'wither', 'aura', 'bubble', 'strike', 'reaver'),
      ...x2('renew', 'purify', 'surge'),
      'empower', 'purify',
    ],
  },
  {
    id: 'balanced',
    name: 'Balanced',
    desc: 'A little of everything: solid hits, shields, heals, traps, and utility to adapt to any opponent.',
    cards: [
      ...x4('smolder'),
      ...x3('spark', 'strike', 'jab', 'shield', 'blade', 'mend'),
      ...x2('trap', 'pierce', 'empower', 'bubble', 'hook', 'bolt', 'ember'),
      ...x1('sunder', 'wither', 'surge', 'expose'),
    ],
  },
];
