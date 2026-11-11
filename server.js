'use strict';

/* Dünya Savaşı — çok oyunculu sunucu
 * - Kalıcı odalar: oda kuran oyuncu çıksa da oda açık kalır, kodu bilen herkes girer
 * - Yetkili (authoritative) simülasyon: tüm mantık sunucuda, istemci sadece çizer
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* ---------------- harita ---------------- */
const W = 240, H = 120, T = 14;
const P = {
  na: [[-168,66],[-140,70],[-95,72],[-80,70],[-62,58],[-53,47],[-70,43],[-76,35],[-80,25],[-90,29],[-97,26],[-97,18],[-88,16],[-83,9],[-78,8],[-86,13],[-105,20],[-117,32],[-124,40],[-124,48],[-135,58],[-150,60],[-165,60]],
  sa: [[-78,8],[-60,11],[-50,0],[-35,-6],[-40,-22],[-48,-28],[-58,-38],[-65,-42],[-68,-52],[-72,-52],[-73,-40],[-71,-18],[-81,-5],[-80,0]],
  eu: [[-10,36],[-9,43],[-2,47],[-5,48],[5,52],[8,55],[10,58],[5,62],[15,69],[30,71],[60,70],[80,73],[110,77],[140,72],[170,70],[180,66],[160,60],[155,52],[140,52],[135,43],[127,39],[122,40],[121,31],[110,21],[106,10],[100,13],[100,2],[104,1],[98,8],[92,22],[80,14],[77,8],[73,18],[67,25],[57,25],[56,27],[50,30],[48,29],[56,17],[43,13],[35,28],[33,31],[27,37],[36,36],[26,40],[24,38],[20,40],[18,40],[13,45],[16,38],[9,44],[3,43],[-5,36]],
  af: [[-17,21],[-10,35],[10,37],[32,31],[35,28],[43,12],[51,12],[40,-3],[40,-15],[35,-24],[27,-34],[18,-34],[12,-17],[9,0],[-8,4],[-17,14]],
  au: [[114,-22],[130,-12],[142,-11],[153,-26],[148,-38],[135,-35],[115,-34]],
  gr: [[-55,60],[-20,70],[-20,82],[-60,82],[-70,76]],
  uk: [[-5,50],[2,52],[-2,58],[-6,56]],
  jp: [[130,32],[140,36],[142,44],[140,41],[132,34]],
  mg: [[44,-25],[50,-15],[47,-13],[43,-20]]
};
const pip = (px, py, poly) => {
  let c = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = poly[i], [d, e] = poly[j];
    if ((b > py) !== (e > py) && px < (d - a) * (py - b) / (e - b) + a) c = !c;
  }
  return c;
};
const land = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const lo = -180 + (x + .5) * 1.5, la = 90 - (y + .5) * 1.5;
  for (const k in P) if (pip(lo, la, P[k])) { land[y * W + x] = 1; break; }
}
const isL = (x, y) => x >= 0 && y >= 0 && x < W && y < H && land[(y | 0) * W + (x | 0)] === 1;
const coastal = (x, y) => {
  for (let a = -1; a < 2; a++) for (let b = -1; b < 2; b++) {
    if (!isL(x + a, y + b) && x + a >= 0 && y + b >= 0 && x + a < W && y + b < H) return true;
  }
  return false;
};

/* ---------------- oyun sabitleri (tek oyunculu sürümden) ---------------- */
const BC = {
  house: { wood: 25, stone: 15 }, barracks: { wood: 30, stone: 20 }, tower: { wood: 20, stone: 20 },
  wall: { stone: 5 }, bunker: { stone: 40, iron: 15 }, cannon: { iron: 30, coal: 10 },
  port: { wood: 40, stone: 30 }, plant: { iron: 40, stone: 40, coal: 20 }, silo: { iron: 60, stone: 50, uran: 10 },
  farm: { wood: 30, stone: 10 }, goldmine: { wood: 40, stone: 40 }, smith: { stone: 30, iron: 15 }
};
const BH = {
  camp: 500, house: 80, barracks: 150, tower: 120, wall: 100, bunker: 350, cannon: 200,
  port: 150, plant: 250, silo: 250, farm: 100, goldmine: 150, smith: 150
};
const US = {
  worker: { hp: 30, sp: 1.5, atk: 0, rg: 1, c: { fish: 10 }, at: 'camp', n: 'İşçi' },
  soldier: { hp: 60, sp: 1.4, atk: 7, rg: 1.6, c: { fish: 10, wood: 5 }, at: 'barracks', n: 'Asker' },
  tank: { hp: 200, sp: 1.1, atk: 22, rg: 3, c: { iron: 20, coal: 10 }, at: 'barracks', n: 'Tank' },
  cmd: { hp: 130, sp: 1.4, atk: 10, rg: 1.6, c: { gold: 30, fish: 20 }, at: 'barracks', n: 'Komutan' },
  ship: { hp: 150, sp: 1.8, atk: 15, rg: 6, c: { iron: 25, wood: 20 }, at: 'port', n: 'Savaş Gemisi', water: 1 }
};
const TUR = { tower: { r: 7, d: 6 }, bunker: { r: 5, d: 14 }, cannon: { r: 9, d: 20 }, camp: { r: 5, d: 4 } };
const LV = { soldier: 10, cmd: 10, tank: 30, ship: 15, plant: 100, silo: 100 };
const PR = { wood: 1, fish: 1, wheat: 1, stone: 1.5, iron: 3, coal: 2, gold: 4, uran: 15 };
const TC = ['#2dd4bf', '#ef4444', '#f59e0b', '#a78bfa', '#38bdf8', '#f472b6', '#a3e635', '#fb923c'];
const AI_NAMES = ['Kuzey Krallığı', 'Doğu İmparatorluğu', 'Batı Cumhuriyeti'];
const START_RES = () => ({ wood: 80, fish: 50, stone: 50, iron: 0, coal: 0, gold: 20, uran: 0, wheat: 0, para: 60 });

const stageOf = (lv) => (lv >= 100 ? 4 : lv >= 50 ? 3 : lv >= 25 ? 2 : lv >= 10 ? 1 : 0);
const hostile = (a, b) => a !== b && a !== 9 && b !== 9;
const walkable = (type, x, y) => (US[type] && US[type].water ? (x >= 0 && y >= 0 && x < W && y < H && !isL(x, y)) : isL(x, y));

/* ---------------- oda ---------------- */
let nextPid = 1;
const rooms = new Map();
const lobby = new Set();

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.random() * a.length | 0];

function roomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[Math.random() * A.length | 0]; } while (rooms.has(c));
  return c;
}

function send(p, obj) {
  if (p && p.ws && p.ws.readyState === 1) {
    try { p.ws.send(JSON.stringify(obj)); } catch (e) { /* yoksay */ }
  }
}

class Room {
  constructor(name, max, aiN) {
    this.code = roomCode();
    this.name = String(name || 'Oda').slice(0, 28);
    this.max = Math.max(2, Math.min(8, max | 0 || 4));
    this.aiN = Math.max(0, Math.min(3, aiN | 0 || 0));
    this.players = [];
    this.started = false;
    this.over = false;
    this.win = null;
    this.tm = 0;
    this.ids = 1;
    this.units = [];
    this.blds = [];
    this.nodes = [];
    this.ais = [];
    this.miss = [];
    this.nodeAdd = [];
    this.nodeDel = [];
    this.nodeCh = new Map();
    this.snapTick = 0;
    this.nodeTick = 0;
    this.emp = Date.now();
  }

  info() {
    return {
      code: this.code, name: this.name, max: this.max, ai: this.aiN,
      started: this.started, over: this.over, win: this.win,
      players: this.players.map((p) => ({
        i: p.id, n: p.name, c: p.country, col: p.color, alive: p.alive, on: !!p.ws
      }))
    };
  }

  bcast(obj) {
    for (const p of this.players) send(p, obj);
  }

  ev(text, bad) { this.bcast({ t: 'ev', text, bad: !!bad }); }

  /* --- oyuncu --- */
  addPlayer(ws, d) {
    if (this.players.length >= this.max) return null;
    if (this.started && this.players.filter((p) => p.alive).length >= this.max) return null;

    let color = /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : pick(TC);
    let guard = 0;
    while (this.players.some((p) => p.color.toLowerCase() === color.toLowerCase()) && guard++ < 12) color = pick(TC);

    const p = {
      id: nextPid++, ws,
      name: String(d.name || 'Oyuncu').slice(0, 16),
      country: String(d.country || 'Kara birliği').slice(0, 20),
      color,
      team: nextPid - 1,
      res: START_RES(),
      xp: 0, lv: 1, alive: true, joined: Date.now(), cmdWin: []
    };
    p.team = p.id;
    this.players.push(p);
    if (this.started && !this.over) this.spawnCountry(p);
    return p;
  }

  removePlayer(p) {
    p.ws = null;
    if (!this.started) {
      this.players = this.players.filter((x) => x !== p);
    }
    if (this.players.length === 0) this.hardReset();
    else this.bcast({ t: 'room', room: this.info() });
  }

  hardReset() {
    this.started = false;
    this.over = false;
    this.win = null;
    this.players = [];
    this.units = [];
    this.blds = [];
    this.nodes = [];
    this.ais = [];
    this.miss = [];
    this.nodeAdd = [];
    this.nodeDel = [];
    this.nodeCh.clear();
    this.tm = 0;
    this.ids = 1;
  }

  /* --- dünya kurulumu --- */
  addU(type, team, x, y) {
    const s = US[type];
    const u = { id: this.ids++, type, team, x, y, hp: s.hp, mh: s.hp, cd: 0, task: 'wood', goal: null };
    this.units.push(u);
    return u;
  }

  addB(type, team, x, y, bt) {
    const b = { id: this.ids++, type, team, x: x | 0, y: y | 0, hp: BH[type], mh: BH[type], cd: 0, bt: bt || 0 };
    this.blds.push(b);
    return b;
  }

  has(p, type) {
    return this.blds.some((b) => b.team === p.team && b.type === type && !(b.bt > 0));
  }

  campOf(team) {
    return this.blds.find((b) => b.team === team && b.type === 'camp');
  }

  bldAt(x, y) { return this.blds.some((b) => b.x === x && b.y === y); }
  nodeAt(x, y) { return this.nodes.some((n) => n.x === x && n.y === y); }

  nodeType() {
    const r = Math.random();
    if (r < .30) return 'wood';
    if (r < .44) return 'wheat';
    if (r < .62) return 'stone';
    if (r < .76) return 'iron';
    if (r < .88) return 'coal';
    return this.blds.some((b) => b.type === 'plant') ? 'uran' : 'stone';
  }

  pushNode(x, y, t) {
    const n = { id: this.ids++, x, y, t, a: 30 };
    this.nodes.push(n);
    this.nodeAdd.push([n.id, x, y, t]);
    return n;
  }

  spawnNode() {
    if (this.nodes.length >= 900) return;
    const wantFish = Math.random() < .13;
    for (let k = 0; k < 40; k++) {
      const x = Math.random() * W | 0, y = Math.random() * H | 0;
      if (wantFish ? (!coastal(x, y) || isL(x, y)) : !isL(x, y)) continue;
      if (this.nodeAt(x, y) || this.bldAt(x, y)) continue;
      this.pushNode(x, y, wantFish ? 'fish' : this.nodeType());
      return;
    }
  }

  cluster(cx, cy, n) {
    for (let i = 0; i < n && this.nodes.length < 900; i++) {
      const x = (cx + Math.random() * 34 - 17) | 0;
      const y = (cy + Math.random() * 34 - 17) | 0;
      if (!isL(x, y) || this.nodeAt(x, y) || this.bldAt(x, y)) continue;
      this.pushNode(x, y, this.nodeType());
    }
  }

  spot() {
    let best = null, bd = -1;
    for (let k = 0; k < 500; k++) {
      const x = Math.random() * W | 0, y = Math.random() * H | 0;
      if (!isL(x, y)) continue;
      if (this.blds.some((b) => Math.abs(b.x - x) < 3 && Math.abs(b.y - y) < 3)) continue;
      if (this.nodes.some((n) => Math.abs(n.x - x) < 1 && Math.abs(n.y - y) < 1)) continue;
      let d = 1e9;
      for (const b of this.blds) if (b.type === 'camp') d = Math.min(d, Math.hypot(b.x - x, b.y - y));
      if (d > bd) { bd = d; best = [x, y]; }
      if (bd > 42) break;
    }
    return best || [W >> 1, H >> 1];
  }

  spawnCountry(p) {
    const [x, y] = this.spot();
    p.res = START_RES();
    p.xp = 0; p.lv = 1; p.alive = true;
    p.team = p.id;
    this.addB('camp', p.team, x, y);
    for (let i = 0; i < 3; i++) this.addU('worker', p.team, x + rand(-1, 1), y + 1);
    this.cluster(x, y, 90);
  }

  addAI() {
    const n = this.ais.length;
    const [x, y] = this.spot();
    const team = 100 + n + 1;
    const a = { team, name: AI_NAMES[n % AI_NAMES.length], color: TC[(n + 4) % TC.length], alive: true, t: rand(0, 10), wave: rand(40, 70), cx: x, cy: y };
    this.ais.push(a);
    this.addB('camp', team, x, y);
    this.addB('tower', team, x + 1, y);
    for (let i = 0; i < 3; i++) this.addU('soldier', team, x, y + 1);
  }

  start() {
    if (this.started) return;
    if (!this.players.length) return;
    this.started = true;
    this.over = false;
    this.win = null;
    this.tm = 0;
    this.ids = 1;
    this.units = [];
    this.blds = [];
    this.nodes = [];
    this.ais = [];
    this.miss = [];
    this.nodeAdd = [];
    this.nodeDel = [];
    this.nodeCh.clear();
    for (const p of this.players) this.spawnCountry(p);
    for (let i = 0; i < this.aiN; i++) this.addAI();
    for (let i = 0; i < 320; i++) this.spawnNode();
    for (const p of this.players) {
      const c = this.campOf(p.team);
      if (c) this.cluster(c.x, c.y, 110);
    }
    this.bcast({ t: 'room', room: this.info() });
    this.bcast({ t: 'ev', text: 'Savaş başladı!' });
    for (const p of this.players) send(p, { t: 'start' });
  }

  /* --- simülasyon yardımcıları --- */
  step(u, tx, ty, dt) {
    const d = Math.hypot(tx - u.x, ty - u.y);
    if (d < .05) return;
    const v = Math.min(d, US[u.type].sp * dt);
    const mx = (tx - u.x) / d * v, my = (ty - u.y) / d * v;
    if (walkable(u.type, u.x + mx, u.y + my)) { u.x += mx; u.y += my; }
    else if (walkable(u.type, u.x + mx, u.y)) u.x += mx;
    else if (walkable(u.type, u.x, u.y + my)) u.y += my;
  }

  near(u, range) {
    let m = range || 9, tg = null;
    for (const o of this.units) {
      if (!hostile(u.team, o.team)) continue;
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (d < m) { m = d; tg = o; }
    }
    if (tg) return tg;
    for (const o of this.blds) {
      if (!hostile(u.team, o.team)) continue;
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (d < m) { m = d; tg = o; }
    }
    return tg;
  }

  nodeDie(n) {
    const i = this.nodes.indexOf(n);
    if (i >= 0) this.nodes.splice(i, 1);
    this.nodeDel.push(n.id);
    this.nodeCh.delete(n.id);
  }

  pop(team) { return this.units.filter((u) => u.team === team).length; }
  cap(team) {
    const houses = this.blds.filter((b) => b.team === team && b.type === 'house' && !(b.bt > 0)).length;
    return 5 + 3 * houses + (this.campOf(team) ? 3 : 0);
  }

  can(p, c) { return Object.keys(c).every((k) => p.res[k] >= c[k]); }
  pay(p, c) { for (const k in c) p.res[k] -= c[k]; }

  tick(dt) {
    if (!this.started || this.over) return;
    this.tm += dt;
    const R = this;

    if (Math.random() < dt / 1.3) R.spawnNode();

    /* --- birlikler --- */
    for (const u of R.units) {
      const st = US[u.type];
      if (!st) continue;
      u.cd -= dt;

      if (u.type === 'worker') {
        const owner = R.players.find((p) => p.team === u.team);
        if (!owner) continue;
        let bd = 1e9, bn = null;
        for (const n of R.nodes) {
          if (n.t !== u.task) continue;
          if (n.t === 'uran' && !R.has(owner, 'plant')) continue;
          const d = Math.hypot(n.x - u.x, n.y - u.y);
          if (d < bd) { bd = d; bn = n; }
        }
        if (!bn) continue;
        if (bd < 1.7) {
          if (u.cd <= 0) {
            u.cd = .6;
            bn.a -= 2;
            R.nodeCh.set(bn.id, bn.a);
            owner.res[bn.t] += 2;
            if (Math.random() < .4) owner.res.para++;
            owner.xp += 2;
            if (bn.a <= 0) R.nodeDie(bn);
          }
        } else R.step(u, bn.x, bn.y, dt);
        continue;
      }

      if (u.type === 'thief') {
        let bd = 1e9, tg = null;
        for (const b of R.blds) {
          if (!(b.team > 0 && b.team < 100)) continue;
          const d = Math.hypot(b.x - u.x, b.y - u.y);
          if (d < bd) { bd = d; tg = b; }
        }
        if (!tg) { u.hp = 0; continue; }
        if (Math.hypot(tg.x - u.x, tg.y - u.y) < 1.2) {
          const owner = R.players.find((p) => p.team === tg.team);
          if (owner) {
            const keys = Object.keys(owner.res).filter((k) => owner.res[k] > 0);
            if (keys.length) {
              const k = pick(keys);
              const s = Math.min(owner.res[k], 15);
              owner.res[k] -= s;
              send(owner, { t: 'msg', text: 'Hırsız ' + s + ' kaynak çaldı!', bad: true });
            }
          }
          u.hp = 0;
        } else R.step(u, tg.x, tg.y, dt);
        continue;
      }

      if (st.atk) {
        const tg = R.near(u);
        if (tg) {
          const e = Math.hypot(tg.x - u.x, tg.y - u.y);
          if (e > st.rg) R.step(u, tg.x, tg.y, dt);
          else if (u.cd <= 0) {
            u.cd = 1;
            const boost = R.units.some((c) => c.type === 'cmd' && c.team === u.team && Math.hypot(c.x - u.x, c.y - u.y) < 6) ? 1.5 : 1;
            tg.hp -= st.atk * boost;
          }
        } else if (u.team >= 100 && u.goal) {
          R.step(u, u.goal.x, u.goal.y, dt);
        } else if (u.team < 100) {
          const c = R.campOf(u.team);
          if (c && Math.hypot(u.x - c.x, u.y - c.y) > 6) R.step(u, c.x, c.y, dt);
        }
      }
    }

    /* --- binalar --- */
    for (const b of R.blds) {
      if (b.bt > 0) { b.bt = Math.max(0, b.bt - dt); continue; }
      const t = TUR[b.type];
      if (!t) continue;
      b.cd -= dt;
      if (b.cd > 0) continue;
      let m = t.r, tg = null;
      for (const u of R.units) {
        if (!hostile(b.team, u.team)) continue;
        const d = Math.hypot(u.x - b.x, u.y - b.y);
        if (d < m) { m = d; tg = u; }
      }
      if (tg) { b.cd = 1; tg.hp -= t.d; }
    }

    R.units = R.units.filter((u) => u.hp > 0);
    R.blds = R.blds.filter((b) => b.hp > 0);

    /* --- yapay zekâ --- */
    for (const a of R.ais) {
      if (!a.alive) continue;
      const camp = R.campOf(a.team);
      if (!camp && !R.units.some((u) => u.team === a.team)) { a.alive = false; R.ev(a.name + ' yıkıldı!'); continue; }
      a.t += dt;
      if (a.t > 10) {
        a.t = 0;
        if (camp && R.pop(a.team) < 28) R.addU('soldier', a.team, camp.x, camp.y + 1);
      }
      a.wave -= dt;
      if (a.wave <= 0) {
        a.wave = rand(55, 85);
        const targets = R.players.filter((p) => p.alive).map((p) => R.campOf(p.team)).filter(Boolean);
        if (targets.length) {
          const tg = pick(targets);
          R.units.forEach((u) => { if (u.team === a.team) u.goal = { x: tg.x, y: tg.y }; });
          R.ev('⚠️ ' + a.name + ' saldırıyor!', true);
        }
      }
    }

    /* --- hırsızlar --- */
    if ((R.tm % 40) < dt) {
      for (const p of R.players) {
        if (!p.alive) continue;
        const c = R.campOf(p.team);
        if (!c) continue;
        const ang = rand(0, 6.28);
        for (let i = 0; i < 2; i++) {
          const x = c.x + Math.cos(ang) * 14, y = c.y + Math.sin(ang) * 14;
          if (isL(x, y)) R.addU('thief', 9, x, y);
        }
        send(p, { t: 'msg', text: 'Hırsızlar yaklaşıyor!', bad: true });
      }
    }

    /* --- ekonomi --- */
    for (const p of R.players) {
      if (!p.alive) continue;
      const cnt = (t) => R.blds.filter((b) => b.team === p.team && b.type === t && !(b.bt > 0)).length;
      if ((R.tm % 4) < dt) p.res.gold += cnt('goldmine') * (1 + stageOf(p.lv));
      if ((R.tm % 5) < dt) {
        if (cnt('smith') && p.res.iron >= 2 && p.res.coal >= 1) { p.res.iron -= 2; p.res.coal -= 1; p.res.gold += 4; }
        p.res.para += (2 + cnt('house')) * (1 + stageOf(p.lv));
      }
      if ((R.tm % 3) < dt) p.res.wheat += cnt('farm') * (1 + stageOf(p.lv));
      if ((R.tm % 1) < dt) p.res.gold += 2 * cnt('plant');
    }

    /* --- füzeler --- */
    for (let i = R.miss.length - 1; i >= 0; i--) {
      const m = R.miss[i];
      m.t -= dt;
      if (m.t > 0) continue;
      R.miss.splice(i, 1);
      const q = (o) => Math.hypot(o.x - m.tx, o.y - m.ty) < 4;
      R.units = R.units.filter((u) => !q(u));
      R.blds = R.blds.filter((b) => !q(b));
      for (const n of R.nodes.slice()) if (q(n)) R.nodeDie(n);
      R.ev('☢️ Nükleer patlama!', true);
    }

    /* --- eleme / bitiş --- */
    for (const p of R.players) {
      if (!p.alive) continue;
      if (!R.campOf(p.team) && !R.units.some((u) => u.team === p.team)) {
        p.alive = false;
        R.ev(p.country + ' elendi!');
      }
    }
    const alive = R.players.filter((p) => p.alive);
    if (R.players.length >= 2 && alive.length <= 1) {
      R.over = true;
      R.win = alive[0] ? alive[0].country : null;
      R.ev(R.win ? '🏆 ' + R.win + ' kazandı!' : 'Savaş bitti.');
      R.bcast({ t: 'room', room: R.info() });
    }
  }

  snap(you) {
    return {
      t: 's',
      tm: +this.tm.toFixed(1),
      over: this.over,
      win: this.win,
      ai: this.aiN,
      p: this.players.map((p) => ({
        i: p.id, n: p.name, c: p.country, col: p.color, alive: p.alive, on: !!p.ws,
        lv: p.lv, pop: this.pop(p.team), cap: this.cap(p.team), camp: !!this.campOf(p.team)
      })),
      me: {
        id: you.id, team: you.team, alive: you.alive, lv: you.lv, xp: you.xp,
        res: you.res, pop: this.pop(you.team), cap: this.cap(you.team)
      },
      u: this.units.map((u) => [u.id, u.type, u.team, Math.round(u.hp), +u.x.toFixed(1), +u.y.toFixed(1)]),
      b: this.blds.map((b) => [b.id, b.type, b.team, Math.round(b.hp), b.x, b.y, +(b.bt || 0).toFixed(1), b.mh]),
      a: this.ais.map((a) => ({ i: a.team, n: a.name, col: a.color, alive: a.alive })),
      m: this.miss.map((m) => [m.sx, m.sy, m.tx, m.ty, +m.t.toFixed(2)])
    };
  }
}

/* ---------------- komutlar ---------------- */
function flash(p, text, bad) {
  send(p, { t: 'msg', text, bad: bad !== false });
}

function doCmd(R, p, m) {
  if (!R.started || R.over) return;
  if (!p.alive) return flash(p, 'Elendin, izliyorsun.');
  const now = Date.now();
  p.cmdWin = p.cmdWin.filter((t) => now - t < 1000);
  if (p.cmdWin.length > 25) return;
  p.cmdWin.push(now);

  if (m.a === 'build') {
    const k = m.k, c = BC[k];
    if (!c) return;
    const x = m.x | 0, y = m.y | 0;
    if (!isL(x, y)) return flash(p, 'Karaya inşa et');
    if (R.bldAt(x, y)) return flash(p, 'Dolu');
    if (p.lv < (LV[k] || 0)) return flash(p, 'Seviye ' + LV[k] + ' gerekli');
    if (k === 'port' && !coastal(x, y)) return flash(p, 'Liman kıyıya yapılır');
    if (k === 'silo' && !R.has(p, 'plant')) return flash(p, 'Önce nükleer santral');
    if (!R.can(p, c)) return flash(p, 'Kaynak yetersiz');
    R.pay(p, c);
    R.addB(k, p.team, x, y, 8);
    return flash(p, 'İnşa başladı (8 sn)', false);
  }

  if (m.a === 'train') {
    const k = m.k, d = US[k];
    if (!d) return;
    if (p.lv < (LV[k] || 0)) return flash(p, 'Seviye ' + LV[k] + ' gerekli');
    if (!R.has(p, d.at)) return flash(p, (d.at === 'port' ? 'Liman' : d.at === 'barracks' ? 'Asker Kampı' : 'Kamp') + ' gerekli');
    if (!R.can(p, d.c)) return flash(p, 'Kaynak yetersiz');
    if (R.pop(p.team) >= R.cap(p.team)) return flash(p, 'Nüfus dolu, ev yap');
    const src = R.blds.filter((b) => b.team === p.team && b.type === d.at && !(b.bt > 0));
    if (!src.length) return flash(p, 'Uygun bina yok');
    const b = pick(src);
    R.pay(p, d.c);
    let x = b.x + rand(-1, 1), y = b.y + rand(-1, 1);
    if (d.water) {
      for (let i = 0; i < 40 && isL(x, y); i++) { x = b.x + rand(-3, 3); y = b.y + rand(-3, 3); }
      if (isL(x, y)) return flash(p, 'Kıyıda deniz yok');
    }
    R.addU(k, p.team, x, y);
    return flash(p, US[k].n + ' hazır', false);
  }

  if (m.a === 'task') {
    const k = m.k;
    if (!['wood', 'fish', 'stone', 'iron', 'coal', 'wheat', 'uran'].includes(k)) return;
    if (k === 'uran' && !R.has(p, 'plant')) return flash(p, 'Önce nükleer santral kur (Seviye 100)');
    R.units.forEach((u) => { if (u.team === p.team && u.type === 'worker') u.task = k; });
    return flash(p, 'İşçiler: ' + k, false);
  }

  if (m.a === 'camp') {
    const L = p.lv, c = { wood: 15 + 10 * L, stone: 10 + 8 * L, para: 5 + 2 * L };
    if (!R.campOf(p.team)) return flash(p, 'Kamp yok');
    if (!R.can(p, c)) return flash(p, 'Kaynak yetersiz');
    R.pay(p, c);
    p.lv++;
    return flash(p, 'Kamp Seviye ' + p.lv, false);
  }

  if (m.a === 'hire') {
    if (p.lv < 10) return flash(p, 'Komutan için Kamp Sv 10 gerekli');
    const n = R.units.filter((u) => u.team === p.team && u.type === 'cmd').length;
    const mx = Math.floor(p.lv / 10);
    if (n >= mx) return flash(p, 'Komutan sınırı ' + mx);
    const c = { para: 80 * (n + 1), gold: 30 };
    if (!R.can(p, c)) return flash(p, 'Para/altın yetersiz');
    if (R.pop(p.team) >= R.cap(p.team)) return flash(p, 'Nüfus dolu, ev yap');
    const camp = R.campOf(p.team);
    if (!camp) return flash(p, 'Kamp yok');
    R.pay(p, c);
    R.addU('cmd', p.team, camp.x + rand(-1, 1), camp.y + 1);
    return flash(p, 'Komutan işe alındı', false);
  }

  if (m.a === 'nuke') {
    if (p.lv < 100) return flash(p, 'Nükleer için Seviye 100 gerekli');
    if (!R.has(p, 'silo') || !R.has(p, 'plant')) return flash(p, 'Rampa ve santral gerekli');
    if (p.res.uran < 20) return flash(p, '20 uranyum gerekli');
    const silo = R.blds.find((b) => b.team === p.team && b.type === 'silo' && !(b.bt > 0));
    if (!silo) return flash(p, 'Rampa yok');
    const x = m.x | 0, y = m.y | 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    p.res.uran -= 20;
    R.miss.push({ sx: silo.x, sy: silo.y, tx: x, ty: y, t: 2.5 });
    R.ev('☢️ ' + p.country + ' füze fırlattı!', true);
    return;
  }

  if (m.a === 'eco') {
    const k = m.k, r = m.r;
    if (!PR[r] || (k !== 'buy' && k !== 'sell')) return;
    if (k === 'sell') {
      if (p.res[r] < 50) return flash(p, 'Yetersiz');
      p.res[r] -= 50;
      p.res.para += Math.round(50 * PR[r] * .6);
    } else {
      const price = Math.round(50 * PR[r] * 1.5);
      if (p.res.para < price) return flash(p, 'Para yetersiz');
      p.res.para -= price;
      p.res[r] += 50;
    }
    return;
  }

}

/* ---------------- HTTP ---------------- */
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end('403'); }
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

function roomsList() {
  return [...rooms.values()].map((r) => ({
    code: r.code, name: r.name, players: r.players.length, max: r.max, ai: r.aiN,
    started: r.started, over: r.over
  }));
}

function pushRooms() {
  const data = { t: 'rooms', list: roomsList() };
  for (const ws of lobby) {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(data)); } catch (e) { /* yoksay */ } }
  }
}

function attach(ws, R, d) {
  const p = R.addPlayer(ws, d || {});
  if (!p) {
    ws.send(JSON.stringify({ t: 'err', text: 'Oda dolu ya da oyun başlamış.' }));
    return null;
  }
  ws.room = R;
  ws.player = p;
  lobby.delete(ws);
  send(p, {
    t: 'joined',
    room: R.info(),
    me: { id: p.id, team: p.team },
    started: R.started,
    state: R.started ? R.snap(p) : null,
    nodes: R.started ? R.nodes.map((n) => [n.id, n.x, n.y, n.t]) : null
  });
  R.bcast({ t: 'room', room: R.info() });
  pushRooms();
  return p;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.room = null;
  ws.player = null;
  lobby.add(ws);
  ws.send(JSON.stringify({ t: 'rooms', list: roomsList() }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'rooms') { ws.send(JSON.stringify({ t: 'rooms', list: roomsList() })); return; }

    if (m.t === 'create') {
      if (ws.room) return;
      if (rooms.size >= 60) return ws.send(JSON.stringify({ t: 'err', text: 'Sunucu dolu, sonra dene.' }));
      const R = new Room(m.rname || m.name, m.max || 0, m.ai || 0);
      rooms.set(R.code, R);
      if (!attach(ws, R, m)) { rooms.delete(R.code); }
      return;
    }

    if (m.t === 'join') {
      if (ws.room) return;
      const R = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!R) return ws.send(JSON.stringify({ t: 'err', text: 'Oda bulunamadı.' }));
      attach(ws, R, m);
      return;
    }

    if (m.t === 'leave') {
      const R = ws.room;
      if (!R) return;
      R.removePlayer(ws.player);
      ws.room = null;
      ws.player = null;
      lobby.add(ws);
      ws.send(JSON.stringify({ t: 'left' }));
      pushRooms();
      return;
    }

    const R = ws.room;
    if (!R || !ws.player) return;

    if (m.t === 'start') { R.start(); pushRooms(); return; }

    if (m.t === 'cmd') {
      if (m.a === 'restart') {
        if (!R.over) return;
        const keep = R.players;
        R.hardReset();
        R.players = keep;
        for (const q of keep) { q.alive = true; q.res = START_RES(); q.lv = 1; q.xp = 0; }
        R.bcast({ t: 'reset' });
        R.bcast({ t: 'room', room: R.info() });
        pushRooms();
        return;
      }
      if (m.a === 'leave') {
        R.removePlayer(ws.player);
        ws.room = null; ws.player = null;
        lobby.add(ws);
        ws.send(JSON.stringify({ t: 'left' }));
        pushRooms();
        return;
      }
      doCmd(R, ws.player, m);
      return;
    }
  });

  ws.on('close', () => {
    lobby.delete(ws);
    const R = ws.room;
    if (R && ws.player) {
      R.removePlayer(ws.player);
      pushRooms();
    }
    ws.room = null;
    ws.player = null;
  });
});

/* ---------------- döngü ---------------- */
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* yoksay */ }
  }
}, 25000);

let tickN = 0;
setInterval(() => {
  tickN++;
  for (const R of rooms.values()) {
    if (R.started && !R.over && R.players.some((p) => p.ws)) {
      try { R.tick(.1); } catch (e) { console.error('tick', e); }
    }
    /* anlık görüntü: 5 Hz */
    if (tickN % 2 === 0) {
      for (const p of R.players) {
        if (!p.ws) continue;
        try { send(p, R.snap(p)); } catch (e) { /* yoksay */ }
      }
    }
    /* düğüm farkları: 1 Hz */
    if (tickN % 10 === 0 && (R.nodeAdd.length || R.nodeDel.length || R.nodeCh.size)) {
      const msg = {
        t: 'nd',
        a: R.nodeAdd.splice(0, R.nodeAdd.length),
        d: R.nodeDel.splice(0, R.nodeDel.length),
        c: [...R.nodeCh.entries()]
      };
      R.nodeCh.clear();
      R.bcast(msg);
    }
  }
}, 100);

/* boş odaları 30 dk sonra sil (kuran çıksa da oda açık kalır) */
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [code, R] of rooms) {
    if (R.players.length === 0) {
      if (!R.emp) R.emp = now;
      if (now - R.emp > 30 * 60 * 1000) { rooms.delete(code); changed = true; }
    } else R.emp = 0;
  }
  if (changed) pushRooms();
}, 60000);

setInterval(pushRooms, 5000);

server.listen(PORT, () => {
  console.log('Dünya Savaşı MP → http://localhost:' + PORT);
});
