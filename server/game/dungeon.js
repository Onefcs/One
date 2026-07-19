const { TILE, WALL, FLOOR, ENEMY_DEF, FLOOR_ENEMIES } = require('../../shared/definitions');

function seededRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateDungeon(lvl) {
  const rng = seededRng(lvl * 1337 + 777);
  const DW = 100, DH = 76;
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));

  const rooms = [];
  const wantRooms = Math.min(20 + Math.floor(lvl / 2), 34);

  function inBounds(gx, gy) { return gx >= 0 && gx < DW && gy >= 0 && gy < DH; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function overlaps(bx1, by1, bx2, by2) {
    return rooms.some(r => bx1 < r.bx2 && bx2 > r.bx1 && by1 < r.by2 && by2 > r.by1);
  }

  let tries = 0;
  while (rooms.length < wantRooms && tries < 3000) {
    tries++;
    const shape = rng();

    if (shape < 0.35) {
      // ── Beveled rectangle ─────────────────────────────────────
      const w = 10 + Math.floor(rng() * 14);
      const h =  6 + Math.floor(rng() * 8);
      const x =  1 + Math.floor(rng() * (DW - w - 2));
      const y =  1 + Math.floor(rng() * (DH - h - 2));
      const bevel = Math.floor(rng() * 4);
      if (overlaps(x-1, y-1, x+w+1, y+h+1)) continue;
      rooms.push({
        bx1: x-1, by1: y-1, bx2: x+w+1, by2: y+h+1,
        cx: x + Math.floor(w/2), cy: y + Math.floor(h/2),
        paint() {
          for (let gy = y; gy < y+h; gy++)
            for (let gx = x; gx < x+w; gx++) {
              const ddx = Math.min(gx-x, x+w-1-gx);
              const ddy = Math.min(gy-y, y+h-1-gy);
              if (ddx + ddy >= bevel) paintFloor(gx, gy);
            }
        },
      });

    } else if (shape < 0.55) {
      // ── Oval ──────────────────────────────────────────────────
      const rx = 5 + Math.floor(rng() * 8);
      const ry = 4 + Math.floor(rng() * 6);
      const cx = rx + 1 + Math.floor(rng() * (DW - 2*rx - 2));
      const cy = ry + 1 + Math.floor(rng() * (DH - 2*ry - 2));
      if (overlaps(cx-rx-1, cy-ry-1, cx+rx+1, cy+ry+1)) continue;
      rooms.push({
        bx1: cx-rx-1, by1: cy-ry-1, bx2: cx+rx+1, by2: cy+ry+1,
        cx, cy,
        paint() {
          for (let gy = cy-ry; gy <= cy+ry; gy++)
            for (let gx = cx-rx; gx <= cx+rx; gx++) {
              const nx = (gx-cx)/rx, ny = (gy-cy)/ry;
              if (nx*nx + ny*ny <= 1) paintFloor(gx, gy);
            }
        },
      });

    } else if (shape < 0.75) {
      // ── L-shape (two rectangles) ───────────────────────────────
      const aw = 8 + Math.floor(rng() * 10), ah = 5 + Math.floor(rng() * 6);
      const bw = 5 + Math.floor(rng() * 8), bh = 5 + Math.floor(rng() * 6);
      const flip = rng() > 0.5;
      const rx = 1 + Math.floor(rng() * (DW - aw - 2));
      const ry = 1 + Math.floor(rng() * (DH - ah - bh - 2));
      const bx = flip ? rx + aw - bw : rx;
      const by = ry + ah;
      if (bx < 1 || bx+bw >= DW-1 || by+bh >= DH-1) continue;
      const minX = Math.min(rx, bx), maxX = Math.max(rx+aw, bx+bw);
      if (overlaps(minX-1, ry-1, maxX+1, by+bh+1)) continue;
      rooms.push({
        bx1: minX-1, by1: ry-1, bx2: maxX+1, by2: by+bh+1,
        cx: Math.floor((minX+maxX)/2), cy: Math.floor((ry+by+bh)/2),
        paint() {
          for (let gy = ry; gy < ry+ah; gy++) for (let gx = rx; gx < rx+aw; gx++) paintFloor(gx, gy);
          for (let gy = by; gy < by+bh; gy++) for (let gx = bx; gx < bx+bw; gx++) paintFloor(gx, gy);
        },
      });

    } else {
      // ── Cross / plus ───────────────────────────────────────────
      const hLen = 7 + Math.floor(rng() * 8), hH = 2 + Math.floor(rng() * 3);
      const vLen = 7 + Math.floor(rng() * 8), vW = 2 + Math.floor(rng() * 3);
      const cx = hLen+1 + Math.floor(rng() * (DW - 2*hLen - 2));
      const cy = vLen+1 + Math.floor(rng() * (DH - 2*vLen - 2));
      if (cx-hLen < 1 || cx+hLen >= DW-1 || cy-vLen < 1 || cy+vLen >= DH-1) continue;
      if (overlaps(cx-hLen-1, cy-vLen-1, cx+hLen+1, cy+vLen+1)) continue;
      rooms.push({
        bx1: cx-hLen-1, by1: cy-vLen-1, bx2: cx+hLen+1, by2: cy+vLen+1,
        cx, cy,
        paint() {
          for (let gy = cy-hH; gy <= cy+hH; gy++) for (let gx = cx-hLen; gx <= cx+hLen; gx++) paintFloor(gx, gy);
          for (let gy = cy-vLen; gy <= cy+vLen; gy++) for (let gx = cx-vW; gx <= cx+vW; gx++) paintFloor(gx, gy);
        },
      });
    }
  }

  // Paint all rooms
  rooms.forEach(r => r.paint());

  // Connect rooms with corridors of width 2–3 tiles
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i-1], b = rooms[i];
    let cx = a.cx, cy = a.cy;
    const tx = b.cx, ty = b.cy;
    const cw = 1 + Math.floor(rng() * 2);
    while (cx !== tx) { for (let d = -cw; d <= cw; d++) paintFloor(cx, cy+d); cx += tx > cx ? 1 : -1; }
    while (cy !== ty) { for (let d = -cw; d <= cw; d++) paintFloor(cx+d, cy); cy += ty > cy ? 1 : -1; }
  }

  // Spawn enemies — find a valid floor tile inside each room's bounding box
  const sc = 1 + (lvl - 1) * 0.28;
  const enemyList = [];
  let eid = 0;

  const _enemyByEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));
  function _pickEnemy(rng, isBoss) {
    if (FLOOR_ENEMIES[lvl]) {
      const fe = FLOOR_ENEMIES[lvl];
      const eid = isBoss ? fe.boss : fe.pool[Math.floor(rng() * fe.pool.length)];
      return _enemyByEid.get(eid);
    }
    if (isBoss) return _enemyByEid.get('demon');
    const pool = ['orc', 'troll'];
    return _enemyByEid.get(pool[Math.floor(rng() * pool.length)]);
  }

  rooms.slice(1).forEach((room, idx) => {
    const isBoss = idx === rooms.length - 2;
    const count = isBoss ? 1 : 2 + Math.floor(rng() * (2 + Math.floor(lvl / 3)));
    const bw = room.bx2 - room.bx1, bh = room.by2 - room.by1;

    for (let i = 0; i < count; i++) {
      const d = _pickEnemy(rng, isBoss);

      let ex = room.cx * TILE + TILE/2, ey = room.cy * TILE + TILE/2;
      for (let attempt = 0; attempt < 30; attempt++) {
        const gx = Math.floor(room.bx1 + 1 + rng() * (bw - 2));
        const gy = Math.floor(room.by1 + 1 + rng() * (bh - 2));
        if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) {
          ex = gx * TILE + TILE/2; ey = gy * TILE + TILE/2; break;
        }
      }

      enemyList.push({
        id: `e_${lvl}_${eid++}`,
        ...d,
        isBoss,
        maxHp: Math.floor(d.hp * sc), hp: Math.floor(d.hp * sc),
        atk:   Math.floor(d.atk * (1 + (lvl - 1) * 0.18)),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
        leashX1: room.bx1 * TILE, leashY1: room.by1 * TILE,
        leashX2: room.bx2 * TILE, leashY2: room.by2 * TILE,
      });
    }
  });

  return {
    grid, rooms, w: DW, h: DH,
    spawn: {
      x: rooms[0].cx * TILE + TILE/2,
      y: rooms[0].cy * TILE + TILE/2,
    },
    enemies: enemyList,
  };
}

module.exports = { generateDungeon, TILE, WALL, FLOOR };
