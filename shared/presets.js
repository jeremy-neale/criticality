import { CARDS, validateDeck } from './cards.js';

const x4 = (...ids) => ids.flatMap((id) => [id, id, id, id]);

export const PRESETS = [
  {
    id: 'aggro',
    name: 'Aggro Burn',
    desc: 'All-out aggression: cheap efficient hits, blades to stack damage, and Empower to ramp pips faster.',
    cards: x4(
      'spark', 'bolt', 'strike',
      'jab', 'hook', 'lash',
      'blade', 'empower', 'sunder', 'smolder'
    ),
  },
  {
    id: 'dots',
    name: 'DoT Pressure',
    desc: 'Wear the opponent down with damage-over-time, traps that punish each tick, and auras that keep the pressure on.',
    cards: x4(
      'smolder', 'inferno', 'trap', 'ambush',
      'pierce', 'wither', 'hook', 'lash',
      'blade', 'mend'
    ),
  },
  {
    id: 'turtle',
    name: 'Turtle Control',
    desc: 'Outlast everything: shields, heals, and defensive auras, with Sunder and Strike to close out the game.',
    cards: x4(
      'shield', 'weakness', 'mend', 'renew',
      'sunder', 'expose', 'wither', 'aura',
      'bubble', 'strike'
    ),
  },
  {
    id: 'balanced',
    name: 'Balanced',
    desc: 'A little of everything: solid hits, shields, heals, traps, and utility to adapt to any opponent.',
    cards: [
      ...x4('spark', 'bolt', 'strike', 'jab', 'smolder', 'shield', 'blade', 'mend'),
      ...['trap', 'trap', 'pierce', 'pierce', 'empower', 'empower', 'bubble', 'bubble'],
    ],
  },
];
