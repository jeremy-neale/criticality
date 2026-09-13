#!/usr/bin/env python3
"""Jarvis's Criticality duel client: connects via the sandbox egress proxy,
creates a room, and plays a real game with heuristic damage math."""
import socket, ssl, os, sys, json, base64, hashlib, struct, time, select
from urllib.parse import urlparse

HOST = "criticality-66yma.ondigitalocean.app"
NAME = "Jarvis"

# ---- card table (from shared/cards.js) ----
COST = {'spark':2,'bolt':4,'strike':6,'blast':8,'cataclysm':10,'jab':1,'hook':3,
 'lash':5,'sunder':7,'ember':0,'shield':0,'weakness':0,'blade':0,'pierce':0,
 'aura':0,'empower':0,'trap':0,'ambush':9,'purify':2,'shatter':3,'twinfang':5,
 'reaver':4,'siphon':2,'cinder':6,'smolder':3,'inferno':6,'mend':2,'renew':4,
 'expose':0,'wither':0,'bubble':2,'surge':4}
DMG = {'spark':210,'bolt':440,'strike':680,'blast':950,'cataclysm':1200,'jab':80,
 'hook':150,'lash':320,'sunder':500,'ember':80,'ambush':1000,'shatter':260,
 'twinfang':240,'reaver':240,'siphon':120,'surge':200,'cinder':400,'smolder':120,
 'inferno':240}

DECK = (['smolder']*4 +
        ['spark','strike','jab','shield','blade','mend']*3 +
        ['trap','pierce','empower','bubble','hook','bolt','ember']*2 +
        ['sunder','wither','surge','expose'])

def attacker_mult(you, bubble_mine):
    m = 1 + 1.5 + sum(you['blades'])/100.0
    if you.get('outBuff'): m *= 1 + you['outBuff']['v']/100.0
    if bubble_mine: m *= 1.25
    if you.get('weakness'): m *= 1 - you['weakness']/100.0
    if you.get('outAura'): m *= 1 - you['outAura']['v']/100.0
    if you.get('wAura'): m *= 1 - you['wAura']['v']/100.0
    return m

def defender_mult(foe, pierce, shields, traps):
    dm = 1 - max(0, 0.5 - pierce/100.0)
    if shields > 0: dm *= 1 - max(0, 0.5 - pierce/100.0)
    ia = foe.get('inAura')
    if ia:
        v = ia['v']
        dm *= (1 - max(0, -v/100.0 - pierce/100.0)) if v < 0 else (1 + v/100.0)
    tm = 1 + (0.4 if traps > 0 else 0)
    return dm * tm

def est_hit(base, you, foe, bubble_mine, pierce_bonus=0, shields=None, traps=None):
    am = attacker_mult(you, bubble_mine)
    pierce = 30 + pierce_bonus
    sh = foe['shields'] if shields is None else shields
    tr = len(foe['traps']) if traps is None else traps
    return max(0, round(base * am * defender_mult(foe, pierce, sh, tr))), am

def est_tick(tick, am, you, foe, bubble_mine, shields_left):
    # ticks use base pierce only, attMult captured at cast
    pierce = 30
    sh = shields_left
    tr = len(foe['traps'])
    dm = 1 - max(0, 0.5 - pierce/100.0)
    if sh > 0: dm *= 1 - max(0, 0.5 - pierce/100.0)
    ia = foe.get('inAura')
    if ia:
        v = ia['v']
        dm *= (1 - max(0, -v/100.0 - pierce/100.0)) if v < 0 else (1 + v/100.0)
    tm = 1 + (0.4 if tr > 0 else 0)
    return max(0, round(tick * am * dm * tm))

def est_damage(cid, you, foe, bubble_mine):
    pb = 30 if you.get('pierceBlade') else 0
    if cid == 'twinfang':
        d1, am = est_hit(240, you, foe, bubble_mine, pb)
        d2, _ = est_hit(240, you, foe, bubble_mine, pb,
                        shields=max(0, foe['shields']-1), traps=max(0, len(foe['traps'])-1))
        return d1 + d2
    if cid == 'shatter':
        d, _ = est_hit(260, you, foe, bubble_mine, pb, shields=max(0, foe['shields']-1))
        return d
    if cid in ('smolder', 'inferno', 'cinder'):
        base = {'smolder':120,'inferno':240,'cinder':400}[cid]
        tick = {'smolder':80,'inferno':110,'cinder':70}[cid]
        n = {'smolder':3,'inferno':4,'cinder':2}[cid]
        d, am = est_hit(base, you, foe, bubble_mine, pb)
        sh = max(0, foe['shields'] - 1)
        for _ in range(n):
            d += est_tick(tick, am, you, foe, bubble_mine, sh)
            sh = max(0, sh - 1)
        return d
    if cid in DMG:
        d, _ = est_hit(DMG[cid], you, foe, bubble_mine, pb)
        return d
    return 0

def in_hand(hand, *ids):
    for i, c in enumerate(hand):
        if c in ids: return i, c
    return None

def decide(snap):
    you, foe = snap['you'], snap['foe']
    bubble_mine = bool(snap.get('bubble')) and snap['bubble'].get('owner') == 'you'
    hand = you['hand']
    pips = you['pips']
    aff = [(i, c) for i, c in enumerate(hand) if COST[c] <= pips]
    dmg = [(est_damage(c, you, foe, bubble_mine), COST[c], i, c)
           for i, c in aff if c in DMG]
    dmg.sort(key=lambda x: (-x[0], x[1]))
    has = lambda *ids: in_hand([c for _, c in aff], *ids)

    # 1. lethal
    leth = [d for d in dmg if d[0] >= foe['hp']]
    if leth:
        leth.sort(key=lambda x: x[1])
        _, _, i, c = leth[0]
        return {'type':'play','hand':i}, f"LETHAL with {c}"
    # 2. heal when low
    if you['hp'] <= 3500:
        h = has('renew','mend')
        if h: return {'type':'play','hand':h[0]}, f"heal {h[1]} at {you['hp']}hp"
    # 3. purify stacked dots
    if len(you['dots']) >= 2:
        h = has('purify')
        if h: return {'type':'play','hand':h[0]}, "purify dots"
    # 4. empower ramp
    if pips <= 4 and you['hp'] > 5500:
        h = has('empower')
        if h: return {'type':'play','hand':h[0]}, "empower ramp"
    # 5. battle aura
    if not you.get('outBuff'):
        h = has('aura')
        if h: return {'type':'play','hand':h[0]}, "battle aura"
    # 6. bubble
    if not bubble_mine:
        h = has('bubble')
        if h: return {'type':'play','hand':h[0]}, "set bubble"
    # 7. strip their brace
    if foe.get('inAura') and foe['inAura']['v'] < 0:
        h = has('expose')
        if h: return {'type':'play','hand':h[0]}, "expose their brace"
    # 8. blade setup
    if not you['blades']:
        h = has('blade')
        if h and any(COST[c] >= 3 for _, c in aff if c in DMG):
            return {'type':'play','hand':h[0]}, "blade setup"
    # 9. trap before a big hit
    if not foe['traps']:
        h = has('trap')
        if h and any(c in DMG for _, c in aff):
            return {'type':'play','hand':h[0]}, "trap"
    # 10. best damage
    if dmg:
        _, _, i, c = dmg[0]
        return {'type':'play','hand':i}, f"hit {c} (~{dmg[0][0]} dmg)"
    # 11. wither their offense
    if foe['pips'] >= 8 and not foe.get('wAura'):
        h = has('wither')
        if h: return {'type':'play','hand':h[0]}, "wither"
    for util, why in (('weakness',"weaken foe"),('shield',"shield up"),('pierce',"pierce blade")):
        h = has(util)
        if h: return {'type':'play','hand':h[0]}, why
    # 12. redraw dead cards
    dead = [i for i, c in enumerate(hand) if COST[c] > pips]
    if dead and you['deckCount'] > 0:
        return {'type':'redraw','hand':dead}, f"redraw {len(dead)}"
    return {'type':'pass'}, "pass"

# ---- websocket over egress proxy (stdlib only) ----
def ws_connect():
    px = urlparse(os.environ['https_proxy'])
    s = socket.create_connection((px.hostname, px.port), timeout=20)
    auth = base64.b64encode(f"{px.username}:{px.password}".encode()).decode()
    s.sendall(f"CONNECT {HOST}:443 HTTP/1.1\r\nHost: {HOST}:443\r\n"
              f"Proxy-Authorization: Basic {auth}\r\n\r\n".encode())
    resp = b""
    while b"\r\n\r\n" not in resp: resp += s.recv(4096)
    if b" 200 " not in resp.split(b"\r\n")[0]: raise RuntimeError("proxy CONNECT failed")
    ss = ssl.create_default_context().wrap_socket(s, server_hostname=HOST)
    key = base64.b64encode(os.urandom(16)).decode()
    ss.sendall(f"GET / HTTP/1.1\r\nHost: {HOST}\r\nUpgrade: websocket\r\n"
              f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
              f"Sec-WebSocket-Version: 13\r\n\r\n".encode())
    resp = b""
    while b"\r\n\r\n" not in resp: resp += ss.recv(4096)
    if b" 101 " not in resp.split(b"\r\n")[0]: raise RuntimeError("WS upgrade failed")
    return ss

def ws_send(ss, obj):
    data = json.dumps(obj).encode()
    mask = os.urandom(4)
    if len(data) < 126:
        hdr = bytes([0x81, 0x80 | len(data)])
    elif len(data) < 65536:
        hdr = bytes([0x81, 0x80 | 126]) + struct.pack('>H', len(data))
    else:
        hdr = bytes([0x81, 0x80 | 127]) + struct.pack('>Q', len(data))
    ss.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

def recvn(ss, n):
    buf = b""
    while len(buf) < n:
        chunk = ss.recv(n - len(buf))
        if not chunk: raise ConnectionError("closed")
        buf += chunk
    return buf

def ws_recv(ss):
    h = recvn(ss, 2)
    op, ln = h[0] & 0x0F, h[1] & 0x7F
    if ln == 126: ln = struct.unpack('>H', recvn(ss, 2))[0]
    elif ln == 127: ln = struct.unpack('>Q', recvn(ss, 8))[0]
    if h[1] & 0x80: mask = recvn(ss, 4)
    else: mask = None
    payload = recvn(ss, ln) if ln else b""
    if mask: payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    if op == 0x9:  # ping -> masked pong (RFC 6455: client frames must be masked)
        mask = os.urandom(4)
        ss.sendall(b"\x8a\x80" + mask)
        return ws_recv(ss)
    if op == 0x8: raise ConnectionError("server closed")
    return json.loads(payload.decode())

def log(*a): print(*a, flush=True)

def run_session(code=None, token=None):
    ss = ws_connect()
    ss.settimeout(45)
    state = {'code': code, 'token': token, 'seat': -1, 'acted': set(),
             'neg_sent': False, 'deck_sent': False, 'phase': None}
    ws_send(ss, {'t': 'join' if code else 'create', **(
        {'code': code, 'token': token, 'name': NAME} if code else {'name': NAME})})
    while True:
        try: m = ws_recv(ss)
        except (socket.timeout, ConnectionError) as e:
            log("connection lost:", e); return state
        t = m.get('t')
        if t == 'room':
            state.update(code=m['code'], token=m['token'], seat=m['seat'])
            if not code:
                log(f"ROOM CODE: {m['code']}")
                log(f"INVITE: https://{HOST}/?code={m['code']}")
        elif t == 'lobby':
            state['phase'] = m['phase']
            names = m['names']
            if m['phase'] == 'lobby' and names[0] and names[1] and not state['neg_sent']:
                ws_send(ss, {'t': 'neg_ready'}); state['neg_sent'] = True
                log(f"{names[1]} joined — readied up in lobby")
            elif m['phase'] == 'build' and not state['deck_sent']:
                ws_send(ss, {'t': 'deck', 'cards': DECK})
                ws_send(ss, {'t': 'ready'}); state['deck_sent'] = True
                log("deck submitted, readied for duel")
            elif m['phase'] == 'duel':
                log("--- duel started ---")
        elif t == 'state':
            snap = m['snap']
            if snap['winner']:
                log(f"GAME OVER: {snap['winner']} ({snap.get('winReason')})")
                return None
            for e in m.get('events', []):
                k = e.get('k')
                if k == 'dmg':
                    who = 'YOU' if e['to'] == state['seat'] else 'FOE'
                    log(f"  dmg {who} -{e['amount']}" + (" (dot)" if e.get('dot') else ""))
                elif k == 'heal':
                    who = 'YOU' if e['to'] == state['seat'] else 'FOE'
                    log(f"  heal {who} +{e['amount']}")
                elif k == 'turn':
                    log(f"-- turn {e['turnNum']}: {'your' if e['seat']==state['seat'] else 'foe'} move --")
            if snap['current'] == 'you' and snap['turnNum'] not in state['acted']:
                state['acted'].add(snap['turnNum'])
                time.sleep(2)
                action, why = decide(snap)
                log(f"you play: {why}  (you {snap['you']['hp']}hp/{snap['you']['pips']}p, foe {snap['foe']['hp']}hp)")
                ws_send(ss, {'t': 'action', 'action': action})
        elif t == 'over':
            log(f"RESULT: {m['winner']} ({m.get('reason')})")
            return None
        elif t == 'error':
            log("server error:", m.get('msg'))
        elif t == 'opponentGone':
            log("opponent disconnected — waiting for rejoin")
        elif t == 'peerBack':
            log("opponent is back")

def main():
    code, token = None, None
    for attempt in range(6):
        try:
            st = run_session(code, token)
        except Exception as e:
            log("session error:", e); st = {'code': code, 'token': token}
        if st is None: log("done."); return
        code, token = st.get('code'), st.get('token')
        log(f"reconnecting in 3s (attempt {attempt+1})...")
        time.sleep(3)

if __name__ == '__main__':
    main()
