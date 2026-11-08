'use strict';
/* Ülke Oyunu - çok oyunculu sunucu (bağımlılıksız: sadece Node.js) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'worlds.json');
const SIZE = 80;
const TICK_MS = 400;
const MAX_WORLDS = 40;
const MAX_WORLDS_PER_PLAYER = 3;
const MAX_COUNTRIES = 8;
const ERA1_LVL = +process.env.ERA1_LVL || 10, ERA2_LVL = +process.env.ERA2_LVL || 20;
const CARRY = 3, GATHER_TICKS = 4;

const BUILD = {
  house:    { cost: { wood: 25, stone: 15 }, hp: 8,  ticks: 15 },
  barracks: { cost: { wood: 30, stone: 20 }, hp: 10, ticks: 25 },
  smith:    { cost: { wood: 20, stone: 30 }, hp: 10, ticks: 25 },
  depo:     { cost: { wood: 20, stone: 10 }, hp: 15, ticks: 15 },
  tower:    { cost: { wood: 25, stone: 15 }, hp: 8,  ticks: 20 },
  wall:     { cost: { stone: 5 },            hp: 6,  ticks: 1 },
};
const CAMP_HP = 12;
const GATHER = {
  wood: { ntype: 'tree', res: 'wood' },
  fish: { ntype: 'fish', res: 'fish' },
  mine: { ntype: 'rock', res: 'stone' },
  iron: { ntype: 'iron', res: 'iron' },
};
const NODE_AMOUNT = { tree: 8, rock: 15, iron: 12, fish: 25 };

/* ---------------- yardımcılar ---------------- */
const rid = () => crypto.randomBytes(5).toString('hex');
function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}
function hashPass(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString('hex');
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- dünya üretimi ---------------- */
function genTerrain(seed) {
  const rnd = mulberry32(seed);
  const makeNoise = cell => {
    const n = Math.ceil(SIZE / cell) + 2;
    const g = Array.from({ length: n * n }, () => rnd());
    return (x, y) => {
      const fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[iy * n + ix], b = g[iy * n + ix + 1], c = g[(iy + 1) * n + ix], d = g[(iy + 1) * n + ix + 1];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  };
  const n1 = makeNoise(20), n2 = makeNoise(9), n3 = makeNoise(4);
  const tiles = new Uint8Array(SIZE * SIZE).fill(1);
  const half = SIZE / 2;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - half, y - half) / half;
    const h = 0.55 * n1(x, y) + 0.3 * n2(x, y) + 0.15 * n3(x, y) - d * d * 0.6;
    if (h > 0.22) tiles[y * SIZE + x] = 0;
  }
  // sadece en büyük kara parçasını tut
  const comp = new Int32Array(SIZE * SIZE).fill(-1);
  let best = -1, bestSize = 0, cid = 0;
  const stack = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (tiles[i] !== 0 || comp[i] !== -1) continue;
    let size = 0; stack.push(i); comp[i] = cid;
    while (stack.length) {
      const c = stack.pop(); size++;
      const x = c % SIZE, y = (c / SIZE) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const ni = ny * SIZE + nx;
        if (tiles[ni] === 0 && comp[ni] === -1) { comp[ni] = cid; stack.push(ni); }
      }
    }
    if (size > bestSize) { bestSize = size; best = cid; }
    cid++;
  }
  for (let i = 0; i < SIZE * SIZE; i++) if (tiles[i] === 0 && comp[i] !== best) tiles[i] = 1;
  return { tiles, land: bestSize, rnd, n1, n2 };
}

function createWorldData(name, passHash, salt, ownerId, ownerName) {
  let seed = (Math.random() * 1e9) | 0, t;
  for (let tries = 0; tries < 30; tries++) {
    t = genTerrain(seed + tries * 7919);
    if (t.land >= 1800) break;
  }
  const { tiles, rnd, n2 } = t;
  const W = {
    id: rid(), name, passHash, salt, ownerId, ownerName, createdAt: Date.now(),
    tiles, nodes: new Map(), countries: [], workers: [], buildings: [],
    nextId: 1, tick: 0,
  };
  const treeNoise = n2;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = y * SIZE + x;
    if (tiles[i] === 0) {
      const r = rnd();
      let type = null;
      if (treeNoise(x + 31, y + 17) > 0.52 && r < 0.55) type = 'tree';
      else if (r < 0.03) type = 'tree';
      else if (rnd() < 0.02) type = 'rock';
      else if (rnd() < 0.011) type = 'iron';
      if (type) addNode(W, type, x, y);
    } else {
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE && tiles[ny * SIZE + nx] === 0;
      });
      if (near && rnd() < 0.22) addNode(W, 'fish', x, y);
    }
  }
  return W;
}
function addNode(W, type, x, y) {
  const n = { id: W.nextId++, type, x, y, amount: NODE_AMOUNT[type] };
  W.nodes.set(n.id, n);
  return n;
}

/* ---------------- dünya çalışma zamanı ---------------- */
function prepare(W) {
  W.tiles = W.tiles instanceof Uint8Array ? W.tiles : Uint8Array.from(W.tiles);
  W._clients = new Set();
  W._last = '';
  W._changed = new Set();
  W._deleted = [];
  W._wall = new Int16Array(SIZE * SIZE).fill(-1);
  W._bTile = new Map();
  W._nodeAt = new Set();
  W._wmap = new Map();
  W._bmap = new Map();
  for (const n of W.nodes.values()) if (n.type !== 'fish') W._nodeAt.add(n.y * SIZE + n.x);
  for (const b of W.buildings) indexBuilding(W, b);
  for (const w of W.workers) W._wmap.set(w.id, w);
  for (const c of W.countries) recalc(W, c);
  return W;
}
function indexBuilding(W, b) {
  W._bmap.set(b.id, b);
  W._bTile.set(b.y * SIZE + b.x, b);
  if (b.type === 'wall' && b.done) W._wall[b.y * SIZE + b.x] = b.c;
}
function unindexBuilding(W, b) {
  W._bmap.delete(b.id);
  if (W._bTile.get(b.y * SIZE + b.x) === b) W._bTile.delete(b.y * SIZE + b.x);
  if (W._wall[b.y * SIZE + b.x] === b.c) W._wall[b.y * SIZE + b.x] = -1;
}
const inb = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;
function emptyLand(W, x, y) {
  if (!inb(x, y)) return false;
  const i = y * SIZE + x;
  return W.tiles[i] === 0 && !W._nodeAt.has(i) && !W._bTile.has(i);
}
const countryById = (W, id) => W.countries.find(c => c.id === id);
const countryOfPlayer = (W, pid) => W.countries.find(c => c.owner === pid);
function campOf(W, c) { return W.buildings.find(b => b.c === c.id && b.type === 'camp'); }

function mhFor(w, c) {
  const base = w.sol ? (c.era >= 2 ? 16 : 10) : 6;
  return base + (c.armor || 0) * 2;
}
function recalc(W, c) {
  c.era = c.campLevel >= ERA2_LVL ? 2 : c.campLevel >= ERA1_LVL ? 1 : 0;
  const houses = W.buildings.filter(b => b.c === c.id && b.type === 'house' && b.done).length;
  c.popCap = 4 + 2 * (c.campLevel - 1) + 2 * houses;
  c.pop = 0;
  for (const w of W.workers) {
    if (w.c !== c.id) continue;
    c.pop++;
    const mh = mhFor(w, c);
    if (mh !== w.mh) { w.hp = Math.min(mh, w.hp + Math.max(0, mh - w.mh)); w.mh = mh; }
  }
  const camp = campOf(W, c);
  if (camp) camp.lvl = c.campLevel;
}
function newWorker(W, c, x, y, sol, task) {
  const w = { id: W.nextId++, x, y, c: c.id, sol: !!sol, task: sol ? 'idle' : (task || 'wood'), carry: null, hp: 0, mh: 0 };
  w.mh = mhFor(w, c); w.hp = w.mh;
  W.workers.push(w); W._wmap.set(w.id, w);
  return w;
}
function killWorker(W, w) {
  W._wmap.delete(w.id);
  const i = W.workers.indexOf(w);
  if (i >= 0) W.workers.splice(i, 1);
  w._dead = true;
}
function removeBuilding(W, b) {
  const i = W.buildings.indexOf(b);
  if (i >= 0) W.buildings.splice(i, 1);
  unindexBuilding(W, b);
  const c = countryById(W, b.c);
  if (!c) return;
  if (!W.buildings.some(x => x.c === c.id)) {
    // ülkenin hiç binası kalmadı: ülke yok olur
    for (const w of W.workers.filter(w => w.c === c.id)) killWorker(W, w);
    W.countries.splice(W.countries.indexOf(c), 1);
    notifyYou(W, c.owner, null);
    return;
  }
  if (b.type === 'camp' && !campOf(W, c) && !W.buildings.some(x => x.c === c.id && x.type === 'depo' && x.done)) {
    c.res.wood = c.res.fish = c.res.stone = c.res.iron = 0; // depo yoksa kaynaklar kaybolur
  }
  recalc(W, c);
}
function canPay(c, cost) { return Object.keys(cost).every(k => (c.res[k] || 0) >= cost[k]); }
function pay(c, cost) { for (const k in cost) c.res[k] -= cost[k]; }
function nearOwn(W, c, x, y, r) {
  return W.buildings.some(b => b.c === c.id && b.done && b.type !== 'wall' && Math.hypot(b.x - x, b.y - y) <= r);
}

/* ---------------- yol bulma ---------------- */
const Q = new Int32Array(SIZE * SIZE), PAR = new Int32Array(SIZE * SIZE), SEEN = new Uint32Array(SIZE * SIZE);
let stamp = 0;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function bfs(W, sx, sy, goal, cid, breaker) {
  stamp++;
  let h = 0, t = 0;
  const s = sy * SIZE + sx;
  Q[t++] = s; SEEN[s] = stamp; PAR[s] = -1;
  while (h < t) {
    const cur = Q[h++];
    const cx = cur % SIZE, cy = (cur / SIZE) | 0;
    if (goal(cx, cy)) {
      const p = []; let k = cur;
      while (k !== s) { p.push(k); k = PAR[k]; }
      p.reverse();
      return p;
    }
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      const ni = ny * SIZE + nx;
      if (SEEN[ni] === stamp || W.tiles[ni] !== 0) continue;
      const wc = W._wall[ni];
      if (wc >= 0 && wc !== cid && !breaker) continue;
      SEEN[ni] = stamp; PAR[ni] = cur; Q[t++] = ni;
    }
  }
  return null;
}
function damageBuilding(W, b, dmg) {
  b.hp -= dmg;
  if (b.hp <= 0) removeBuilding(W, b);
}
// 'arrived' | 'moving' | 'fail'
function stepTo(W, w, key, tx, ty, breaker) {
  if (Math.abs(w.x - tx) + Math.abs(w.y - ty) <= 1) return 'arrived';
  if (!w._path || w._key !== key || !w._path.length) {
    w._path = bfs(W, w.x, w.y, (x, y) => Math.abs(x - tx) + Math.abs(y - ty) <= 1, w.c, breaker);
    w._key = key;
    if (!w._path) return 'fail';
  }
  const ni = w._path[0];
  const wc = W._wall[ni];
  if (wc >= 0 && wc !== w.c) {
    if (breaker) {
      const wb = W._bTile.get(ni);
      if (wb) damageBuilding(W, wb, 1);
      return 'moving';
    }
    w._path = null; return 'moving';
  }
  w._path.shift();
  w.x = ni % SIZE; w.y = (ni / SIZE) | 0;
  return 'moving';
}

/* ---------------- tek işçi / asker güncellemesi ---------------- */
function nearestDeposit(W, w) {
  let best = null, bd = 1e9;
  for (const b of W.buildings) {
    if (b.c !== w.c || !b.done || (b.type !== 'camp' && b.type !== 'depo')) continue;
    const d = Math.abs(b.x - w.x) + Math.abs(b.y - w.y);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
function updateWorker(W, w, c) {
  if (w.sol) return updateSoldier(W, w, c);
  let task = w.task;
  const pending = () => {
    let best = null, bd = 1e9;
    for (const b of W.buildings) {
      if (b.c !== w.c || b.done) continue;
      const d = Math.abs(b.x - w.x) + Math.abs(b.y - w.y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  };
  if (task === 'idle') {
    if (w.carry) return;
    if (!pending()) return;
    task = 'build';
  }
  if (task === 'build') {
    const b = pending();
    if (!b) { if (w.task === 'build') w.task = 'idle'; return; }
    const r = stepTo(W, w, 'b' + b.id, b.x, b.y, false);
    if (r === 'arrived') {
      b.p = Math.min(100, b.p + 100 / BUILD[b.type].ticks);
      if (b.p >= 100) { b.p = 100; b.done = true; indexBuilding(W, b); recalc(W, c); }
    }
    return;
  }
  const g = GATHER[task];
  if (!g) return;
  // taşıdığı farklı türse veya doluysa önce depoya
  if (w.carry && (w.carry.t !== g.res || w.carry.n >= CARRY)) return deposit(W, w, c);
  let node = w._node != null ? W.nodes.get(w._node) : null;
  if (!node || node.amount <= 0 || node.type !== g.ntype) {
    if (w.carry) return deposit(W, w, c);
    node = null; w._node = null;
    let bd = 1e9;
    for (const n of W.nodes.values()) {
      if (n.type !== g.ntype || n.amount <= 0) continue;
      if (w._bad && w._bad.has(n.id)) continue;
      const d = Math.abs(n.x - w.x) + Math.abs(n.y - w.y);
      if (d < bd) { bd = d; node = n; }
    }
    if (!node) { if (w._bad && W.tick % 20 === 0) w._bad.clear(); return; }
    w._node = node.id; w._work = 0;
  }
  const r = stepTo(W, w, 'n' + node.id, node.x, node.y, false);
  if (r === 'fail') {
    (w._bad = w._bad || new Set()).add(node.id);
    w._node = null;
    return;
  }
  if (r === 'arrived') {
    w._work = (w._work || 0) + 1;
    if (w._work >= GATHER_TICKS) {
      w._work = 0;
      const take = Math.min(CARRY - (w.carry ? w.carry.n : 0), node.amount);
      node.amount -= take;
      w.carry = { t: g.res, n: (w.carry ? w.carry.n : 0) + take };
      if (node.amount <= 0) {
        W.nodes.delete(node.id);
        W._nodeAt.delete(node.y * SIZE + node.x);
        W._deleted.push(node.id);
        W._changed.delete(node.id);
        w._node = null;
      } else W._changed.add(node.id);
    }
  }
}
function deposit(W, w, c) {
  const d = nearestDeposit(W, w);
  if (!d) return;
  const r = stepTo(W, w, 'd' + d.id, d.x, d.y, false);
  if (r === 'arrived') {
    c.res[w.carry.t] = (c.res[w.carry.t] || 0) + w.carry.n;
    w.carry = null;
  } else if (r === 'fail') { w._path = null; }
}
function updateSoldier(W, w, c) {
  if (w.task !== 'attack') {
    w.task = 'idle'; w._tgt = null;
    if (W.tick % 3 === 0) { // otomatik savunma
      let best = null, bd = 3;
      for (const e of W.workers) {
        if (e.c === w.c) continue;
        const d = Math.hypot(e.x - w.x, e.y - w.y);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) { w.task = 'attack'; w._tgt = { kind: 'worker', id: best.id }; w._auto = true; w._path = null; }
    }
    if (w.task !== 'attack') return;
  }
  const tg = w._tgt;
  const t = tg && (tg.kind === 'worker' ? W._wmap.get(tg.id) : W._bmap.get(tg.id));
  if (!t || t.c === w.c) { w.task = 'idle'; w._tgt = null; w._auto = false; return; }
  const dist = Math.hypot(t.x - w.x, t.y - w.y);
  if (w._auto && dist > 8) { w.task = 'idle'; w._tgt = null; w._auto = false; return; }
  if (dist <= 1.5) {
    if (W.tick % 2 === 0) {
      if (tg.kind === 'worker') {
        t.hp -= c.era >= 2 ? 3 : 2;
        if (t.hp <= 0) killWorker(W, t);
      } else damageBuilding(W, t, c.era >= 2 ? 2 : 1);
    }
    return;
  }
  stepTo(W, w, 'a' + tg.id + ':' + (tg.kind === 'worker' ? (W.tick >> 2) : 0), t.x, t.y, true);
}

/* ---------------- ana tick ---------------- */
function tickWorld(W) {
  W.tick++;
  for (const w of W.workers.slice()) {
    if (w._dead) continue;
    const c = countryById(W, w.c);
    if (!c) { killWorker(W, w); continue; }
    updateWorker(W, w, c);
  }
  // kuleler
  if (W.tick % 2 === 0) {
    for (const b of W.buildings.slice()) {
      if (b.type !== 'tower' || !b.done) continue;
      let best = null, bd = 6;
      for (const e of W.workers) {
        if (e.c === b.c) continue;
        const d = Math.hypot(e.x - b.x, e.y - b.y);
        if (d <= bd) { bd = d; best = e; }
      }
      if (best) { best.hp -= 1; if (best.hp <= 0) killWorker(W, best); }
    }
  }
  // nüfus artışı + can yenilenmesi
  if (W.tick % 25 === 0) {
    for (const c of W.countries) {
      recalc(W, c);
      const camp = campOf(W, c);
      if (camp && c.pop < c.popCap && c.res.fish >= 5) {
        c.res.fish -= 5;
        newWorker(W, c, camp.x, camp.y, false, 'wood');
      }
    }
    for (const w of W.workers) if (w.hp < w.mh) w.hp++;
  }
  for (const c of W.countries) recalc(W, c);
  broadcastWorld(W);
}
function stateMsg(W) {
  return JSON.stringify({
    t: 'state', online: W._clients.size,
    workers: W.workers.map(w => ({ id: w.id, x: w.x, y: w.y, c: w.c, sol: w.sol ? 1 : 0, task: w.task, carry: w.carry ? { t: w.carry.t, n: w.carry.n } : null, hp: w.hp, mh: w.mh })),
    buildings: W.buildings.map(b => ({ id: b.id, type: b.type, x: b.x, y: b.y, c: b.c, done: b.done, p: Math.round(b.p), hp: b.hp, lvl: b.lvl })),
    countries: W.countries.map(c => ({ id: c.id, name: c.name, color: c.color, res: c.res, pop: c.pop, popCap: c.popCap, era: c.era, armor: c.armor, campLevel: c.campLevel })),
  });
}
function broadcastWorld(W) {
  if (W._deleted.length) { sendWorld(W, { t: 'nodeDel', ids: W._deleted }); W._deleted = []; }
  if (W._changed.size) {
    const nodes = [];
    for (const id of W._changed) { const n = W.nodes.get(id); if (n) nodes.push([n.id, n.type, n.x, n.y, n.amount]); }
    W._changed.clear();
    if (nodes.length) sendWorld(W, { t: 'nodes', nodes });
  }
  const s = stateMsg(W);
  if (s !== W._last) { W._last = s; for (const ws of W._clients) wsSend(ws, s); }
}
function sendWorld(W, obj) { const s = JSON.stringify(obj); for (const ws of W._clients) wsSend(ws, s); }
function notifyYou(W, pid, countryId) {
  for (const ws of W._clients) if (ws._pid === pid) wsSend(ws, JSON.stringify({ t: 'you', countryId }));
}

/* ---------------- dünyalar + kayıt ---------------- */
const worlds = new Map();
let dirty = false;
function toSave(W) {
  return {
    id: W.id, name: W.name, passHash: W.passHash, salt: W.salt, ownerId: W.ownerId, ownerName: W.ownerName,
    createdAt: W.createdAt, nextId: W.nextId, tick: W.tick,
    tiles: Array.from(W.tiles),
    nodes: [...W.nodes.values()],
    countries: W.countries,
    workers: W.workers.map(w => ({ id: w.id, x: w.x, y: w.y, c: w.c, sol: w.sol, task: w.task === 'attack' ? 'idle' : w.task, carry: w.carry, hp: w.hp, mh: w.mh })),
    buildings: W.buildings,
  };
}
function saveAll() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = JSON.stringify([...worlds.values()].map(toSave));
    const tmp = SAVE_FILE + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, SAVE_FILE);
    dirty = false;
  } catch (e) { console.error('Kayıt hatası:', e.message); }
}
function loadAll() {
  try {
    const arr = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    for (const d of arr) {
      d.nodes = new Map(d.nodes.map(n => [n.id, n]));
      worlds.set(d.id, prepare(d));
    }
    console.log(worlds.size + ' dünya yüklendi');
  } catch (e) { if (e.code !== 'ENOENT') console.error('Yükleme hatası:', e.message); }
}
setInterval(() => { if (dirty) saveAll(); }, 20000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveAll(); process.exit(0); });

setInterval(() => {
  for (const W of worlds.values()) {
    if (!W._clients.size) continue;
    try { tickWorld(W); } catch (e) { console.error('tick hatası:', e); }
    dirty = true;
  }
}, TICK_MS);

/* ---------------- WebSocket (elle) ---------------- */
function wsFrame(op, buf) {
  const len = buf.length;
  let h;
  if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
  else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  h[0] = 0x80 | op;
  return Buffer.concat([h, buf]);
}
function wsSend(ws, str) {
  const s = ws._sock;
  if (!s || s.destroyed) return;
  if (s.writableLength > 2 * 1024 * 1024) { s.destroy(); return; }
  s.write(wsFrame(1, Buffer.from(str)));
}
const sendObj = (ws, o) => wsSend(ws, JSON.stringify(o));
const sendErr = (ws, msg) => sendObj(ws, { t: 'error', msg });

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html bulunamadı'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const ws = { _sock: socket, _pid: null, _name: 'Guest', _world: null, _alive: true, _buf: Buffer.alloc(0), _frag: [], _n: 0, _chatAt: 0 };
  let rateT = setInterval(() => { ws._n = 0; }, 1000);
  socket.on('data', chunk => {
    ws._buf = Buffer.concat([ws._buf, chunk]);
    try { parseFrames(ws); } catch (e) { socket.destroy(); }
  });
  const cleanup = () => {
    clearInterval(rateT);
    leaveWorld(ws);
  };
  socket.on('close', cleanup);
  socket.on('error', () => socket.destroy());
  allSockets.add(ws);
  socket.on('close', () => allSockets.delete(ws));
});
const allSockets = new Set();
setInterval(() => {
  for (const ws of allSockets) {
    if (!ws._alive) { ws._sock.destroy(); continue; }
    ws._alive = false;
    if (!ws._sock.destroyed) ws._sock.write(wsFrame(9, Buffer.alloc(0)));
  }
}, 20000);

function parseFrames(ws) {
  for (;;) {
    const b = ws._buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 65536) return ws._sock.destroy();
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return;
    let payload = b.subarray(off + (masked ? 4 : 0), need);
    if (masked) {
      const mk = b.subarray(off, off + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mk[i & 3];
      payload = out;
    }
    ws._buf = b.subarray(need);
    if (op === 8) { ws._sock.end(wsFrame(8, Buffer.alloc(0))); return; }
    if (op === 9) { ws._sock.write(wsFrame(10, payload)); continue; }
    if (op === 10) { ws._alive = true; continue; }
    if (op === 1 || op === 0) {
      ws._alive = true;
      ws._frag.push(payload);
      if (fin) {
        const text = Buffer.concat(ws._frag).toString('utf8');
        ws._frag = [];
        if (++ws._n > 120) continue;
        let msg; try { msg = JSON.parse(text); } catch (e) { continue; }
        if (msg && typeof msg === 'object') {
          try { handleMsg(ws, msg); } catch (e) { console.error('mesaj hatası:', e); }
        }
      }
    }
  }
}

/* ---------------- mesaj işleme ---------------- */
function lobbyList() {
  return [...worlds.values()].map(W => ({
    id: W.id, name: W.name, hasPassword: !!W.passHash, countries: W.countries.length,
    online: W._clients.size, ownerName: W.ownerName, ownerId: W.ownerId, createdAt: W.createdAt,
  }));
}
function leaveWorld(ws) {
  if (ws._world) { ws._world._clients.delete(ws); ws._world = null; }
}
function joinWorld(ws, W) {
  leaveWorld(ws);
  ws._world = W; W._clients.add(ws);
  const my = countryOfPlayer(W, ws._pid);
  sendObj(ws, {
    t: 'joined', world: { id: W.id, name: W.name }, size: SIZE, tiles: Array.from(W.tiles),
    nodes: [...W.nodes.values()].map(n => [n.id, n.type, n.x, n.y, n.amount]),
    workers: JSON.parse(stateMsg(W)).workers, buildings: JSON.parse(stateMsg(W)).buildings,
    countries: JSON.parse(stateMsg(W)).countries, online: W._clients.size,
    you: { playerId: ws._pid, countryId: my ? my.id : null },
  });
  W._last = '';
}
function checkPass(W, pass, pid) {
  if (!W.passHash) return true;
  if (W.ownerId === pid) return true;
  try {
    return crypto.timingSafeEqual(Buffer.from(hashPass(String(pass || ''), W.salt), 'hex'), Buffer.from(W.passHash, 'hex'));
  } catch (e) { return false; }
}

function handleMsg(ws, m) {
  if (m.t === 'hello') {
    ws._pid = clean(m.playerId, 24) || ('p' + rid());
    ws._name = clean(m.name, 20) || 'Guest';
    return sendObj(ws, { t: 'lobby', worlds: lobbyList() });
  }
  if (!ws._pid) return;
  if (m.t === 'lobby') return sendObj(ws, { t: 'lobby', worlds: lobbyList() });
  if (m.t === 'leave') return leaveWorld(ws);

  if (m.t === 'createWorld') {
    const name = clean(m.name, 24);
    if (!name) return sendErr(ws, 'Dünya adı gerekli');
    if (worlds.size >= MAX_WORLDS) return sendErr(ws, 'Sunucu dolu: çok fazla dünya var');
    if ([...worlds.values()].filter(w => w.ownerId === ws._pid).length >= MAX_WORLDS_PER_PLAYER)
      return sendErr(ws, 'En fazla ' + MAX_WORLDS_PER_PLAYER + ' dünyan olabilir');
    const pass = String(m.password || '').slice(0, 30);
    const salt = crypto.randomBytes(8).toString('hex');
    const W = prepare(createWorldData(name, pass ? hashPass(pass, salt) : '', salt, ws._pid, ws._name));
    worlds.set(W.id, W);
    saveAll();
    return joinWorld(ws, W);
  }
  if (m.t === 'joinWorld') {
    const W = worlds.get(m.id);
    if (!W) return sendErr(ws, 'Dünya bulunamadı');
    if (!checkPass(W, m.password, ws._pid)) return sendErr(ws, 'Şifre yanlış');
    return joinWorld(ws, W);
  }
  if (m.t === 'deleteWorld') {
    const W = worlds.get(m.id);
    if (!W || W.ownerId !== ws._pid) return sendErr(ws, 'Bu dünyayı silemezsin');
    sendWorld(W, { t: 'worldDeleted' });
    for (const c of [...W._clients]) c._world = null;
    W._clients.clear();
    worlds.delete(W.id);
    saveAll();
    return;
  }

  const W = ws._world;
  if (!W) return;
  if (m.t === 'chat') {
    const text = clean(m.text, 120);
    const now = Date.now();
    if (!text || now - ws._chatAt < 700) return;
    ws._chatAt = now;
    return sendWorld(W, { t: 'chat', from: ws._name, text });
  }

  if (m.t === 'foundCountry') {
    if (countryOfPlayer(W, ws._pid)) return sendErr(ws, 'Zaten bir ülken var');
    if (W.countries.length >= MAX_COUNTRIES) return sendErr(ws, 'Bu dünya dolu (en fazla ' + MAX_COUNTRIES + ' ülke)');
    const name = clean(m.name, 20);
    if (!name) return sendErr(ws, 'Ülke adı gerekli');
    const color = /^#[0-9a-fA-F]{6}$/.test(m.color) ? m.color : '#e53935';
    if (!emptyLand(W, m.x, m.y)) return sendErr(ws, 'Buraya kurulamaz: boş bir kara karesi seç');
    if (W.buildings.some(b => Math.hypot(b.x - m.x, b.y - m.y) < 12)) return sendErr(ws, 'Başka bir ülkeye çok yakın (en az 12 kare)');
    const c = { id: W.nextId++, owner: ws._pid, ownerName: ws._name, name, color, res: { wood: 30, fish: 10, stone: 20, iron: 0 }, pop: 0, popCap: 4, era: 0, armor: 0, campLevel: 1 };
    W.countries.push(c);
    const camp = { id: W.nextId++, type: 'camp', x: m.x, y: m.y, c: c.id, done: true, p: 100, hp: CAMP_HP, lvl: 1 };
    W.buildings.push(camp); indexBuilding(W, camp);
    newWorker(W, c, m.x, m.y, false, 'wood');
    newWorker(W, c, m.x, m.y, false, 'fish');
    recalc(W, c);
    W._last = '';
    for (const o of W._clients) if (o._pid === ws._pid) sendObj(o, { t: 'you', countryId: c.id });
    return;
  }

  const c = countryOfPlayer(W, ws._pid);
  if (!c) return;

  if (m.t === 'task') {
    const w = W._wmap.get(m.id);
    if (!w || w.c !== c.id) return;
    const ok = ['wood', 'fish', 'mine', 'iron', 'build', 'idle'];
    if (!ok.includes(m.task)) return;
    if (w.sol) { w.task = 'idle'; w._tgt = null; w._auto = false; return; }
    w.task = m.task; w._node = null; w._path = null; w._work = 0; w._bad = null;
    return;
  }
  if (m.t === 'build') {
    const def = BUILD[m.type];
    if (!def) return;
    if (!emptyLand(W, m.x, m.y)) return sendErr(ws, 'Buraya inşa edilemez');
    if (!nearOwn(W, c, m.x, m.y, 10)) return sendErr(ws, 'Sadece kendi bölgende inşa edebilirsin');
    if (!canPay(c, def.cost)) return sendErr(ws, 'Yetersiz kaynak');
    pay(c, def.cost);
    const done = m.type === 'wall';
    const b = { id: W.nextId++, type: m.type, x: m.x, y: m.y, c: c.id, done, p: done ? 100 : 0, hp: def.hp };
    W.buildings.push(b); indexBuilding(W, b);
    recalc(W, c);
    return;
  }
  if (m.t === 'upgradeCamp') {
    const camp = campOf(W, c);
    if (!camp) return sendErr(ws, 'Kampın yok');
    const lvl = c.campLevel;
    const cost = { wood: 15 * lvl, stone: 10 * lvl };
    if (!canPay(c, cost)) return sendErr(ws, 'Yetersiz kaynak');
    pay(c, cost);
    c.campLevel++;
    recalc(W, c);
    if (c.pop < c.popCap) newWorker(W, c, camp.x, camp.y, false, 'wood');
    recalc(W, c);
    return;
  }
  if (m.t === 'train') {
    const bar = W.buildings.find(b => b.c === c.id && b.type === 'barracks' && b.done);
    if (!bar) return sendErr(ws, 'Önce Asker Kampı inşa et');
    if (c.era < 1) return sendErr(ws, 'Asker için kamp seviye ' + ERA1_LVL + ' gerekli');
    recalc(W, c);
    if (c.pop >= c.popCap) return sendErr(ws, 'Nüfus dolu: ev inşa et veya kampı yükselt');
    const cost = { fish: 10, wood: 5 };
    if (!canPay(c, cost)) return sendErr(ws, 'Yetersiz kaynak');
    pay(c, cost);
    newWorker(W, c, bar.x, bar.y, true);
    recalc(W, c);
    return;
  }
  if (m.t === 'upgradeArmor') {
    if (!W.buildings.some(b => b.c === c.id && b.type === 'smith' && b.done)) return sendErr(ws, 'Demirci gerekli');
    if (c.armor >= 3) return sendErr(ws, 'Zırh zaten en üst seviyede');
    const cost = { iron: 10 * (c.armor + 1) };
    if (!canPay(c, cost)) return sendErr(ws, 'Yetersiz demir');
    pay(c, cost);
    c.armor++;
    recalc(W, c);
    return;
  }
  if (m.t === 'rebuildCamp') {
    if (campOf(W, c)) return sendErr(ws, 'Kampın zaten var');
    if (!emptyLand(W, m.x, m.y)) return sendErr(ws, 'Buraya kurulamaz');
    if (!nearOwn(W, c, m.x, m.y, 12)) return sendErr(ws, 'Kendi bölgende kur');
    const cost = { wood: 20, stone: 10 };
    if (!canPay(c, cost)) return sendErr(ws, 'Yetersiz kaynak');
    pay(c, cost);
    const camp = { id: W.nextId++, type: 'camp', x: m.x, y: m.y, c: c.id, done: true, p: 100, hp: CAMP_HP, lvl: c.campLevel };
    W.buildings.push(camp); indexBuilding(W, camp);
    recalc(W, c);
    return;
  }
  if (m.t === 'moveBuilding') {
    const b = W._bmap.get(m.id);
    if (!b || b.c !== c.id || !b.done) return;
    if (!emptyLand(W, m.x, m.y)) return sendErr(ws, 'Buraya taşınamaz');
    if (!nearOwn(W, c, m.x, m.y, 12)) return sendErr(ws, 'Kendi bölgende kal');
    unindexBuilding(W, b);
    b.x = m.x; b.y = m.y;
    indexBuilding(W, b);
    return;
  }
  if (m.t === 'clearNode') {
    const n = W.nodes.get(m.id);
    if (!n || n.type === 'fish') return;
    const res = { tree: 'wood', rock: 'stone', iron: 'iron' }[n.type];
    c.res[res] = (c.res[res] || 0) + 1;
    W.nodes.delete(n.id);
    W._nodeAt.delete(n.y * SIZE + n.x);
    W._changed.delete(n.id);
    W._deleted.push(n.id);
    return;
  }
  if (m.t === 'attack') {
    const w = W._wmap.get(m.id);
    if (!w || w.c !== c.id || !w.sol || !m.target) return;
    const tg = m.target;
    const t = tg.kind === 'worker' ? W._wmap.get(tg.id) : tg.kind === 'building' ? W._bmap.get(tg.id) : null;
    if (!t || t.c === c.id) return;
    w.task = 'attack'; w._tgt = { kind: tg.kind, id: tg.id }; w._auto = false; w._path = null;
    return;
  }
}

/* ---------------- başlat ---------------- */
loadAll();
server.listen(PORT, '0.0.0.0', () => console.log('Ülke Oyunu http://localhost:' + PORT + ' üzerinde çalışıyor'));
