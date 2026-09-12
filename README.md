# ⚔️ Duel Simulator

A bare-bones, zero-RNG PvP duel card game (Wizard101-inspired, no schools).
Deck building → ready up → live duel over WebSocket. One server, one link, two players.

## Play

1. Open the link, enter your name, **Create room** — you get a 4-letter code.
2. Send the code to your opponent; they open the link and **join** with it.
3. Both build a deck (**40–100 cards**, max 4 copies each — the **first 7** are your starting hand, outlined in gold), save it, pick 1st/2nd, hit **Ready**.
4. Duel! 30s per turn, configurable match timer (default 15 min).

There's also a standalone **Card library** page on the home screen — all cards and base stats, no room needed.

## Rules (short version)

- 10,000 HP · +150% damage · 50% resist · 30 pierce. No fizzle, no crit, no RNG.
- First player starts with 5 pips, second with 7. +2 pips at the start of each of your turns (cap 14).
- Each turn: draw 1 card, then **one** move — play a card, pass, or **redraw** (discard any number of cards, draw that many replacements in deck order).
- Damage = base × (1 + damage% + blades + outgoing aura) × (1 − weakness) × (1 − outgoing debuff) × (1 − max(0, resist − pierce)) × shields/brace (pierceable).
- **Weakness** (one at a time, on the hitter): scales the *whole* hit including DoT ticks, then consumed. Cannot be pierced.
- **Shields** queue up; each damage instance (a hit or one DoT tick) uses exactly one shield.
- Auras last 4 rounds and refresh instead of stacking. Blades stack and are all consumed by your next damaging hit.
- Match timer expires → higher HP% wins (tie = draw).

## Tweak the cards

All numbers live in one place: **`shared/cards.js`** (the `CARDS` table and `RULES`).
Change a number, commit, push — DigitalOcean redeploys automatically. This is where
you'll do your nerf/buff passes.

## Run locally

```bash
npm install
node server/index.js
# open http://localhost:8080
```

## Put it on GitHub

```bash
cd duel-simulator
git init
git add .
git commit -m "Duel simulator v1"
# create an empty repo on github.com (e.g. YOURNAME/duel-simulator), then:
git remote add origin git@github.com:YOURNAME/duel-simulator.git
git branch -M main
git push -u origin main
```

(Use `https://github.com/YOURNAME/duel-simulator.git` as the remote if you prefer HTTPS.)

## Host it on DigitalOcean (~$5/mo)

This repo is built for **App Platform** — no server management, deploys straight from GitHub,
WebSockets work out of the box.

1. Log in to DigitalOcean → **Create → Apps**.
2. Choose **GitHub**, authorize, and pick your `duel-simulator` repo / `main` branch.
3. App Platform detects the `Dockerfile` automatically. Keep the suggested settings
   (service name `game`, the smallest `basic-xxs` instance is plenty).
4. Create the app. You'll get a public URL like `https://duel-simulator-xxxxx.ondigitalocean.app`.
5. Send that URL to your opponent. Every push to `main` redeploys automatically.

Notes:
- One tiny instance handles your games easily; check DigitalOcean's current pricing,
  but the smallest service tier is a few dollars a month.
- The included `.do/app.yaml` is a starting point — if you prefer clicking through the
  dashboard, you can ignore it (edit `repo:` in it first if you use it).
- Rooms live in memory: a server restart wipes active rooms (fine for casual play).

## Project layout

```
shared/cards.js    card data + base rules (edit for balance)
shared/engine.js   deterministic duel engine (no I/O)
server/index.js    Node + WebSocket server, authoritative rooms/timers
public/            client: home, card library, deck builder, duel UI
Dockerfile         container for App Platform
.do/app.yaml       App Platform spec (optional)
```
