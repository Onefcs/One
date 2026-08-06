// ─────────────────────────────────────────────────────────
//  Binary codec for gameState packets (shared client/server)
//
//  JSON gameState entries cost ~70-130 bytes each; the binary form is
//  ~13 bytes for a slim player and ~14 for a slim enemy (still 6-9x less),
//  plus far cheaper parsing than JSON on mobile.
//
//  Entries reference entities by small numeric handles (player _seq /
//  enemy _idx); the string ids travel only inside FULL entries, and the
//  decoder keeps handle→id maps that the periodic full refresh repairs
//  if they ever diverge. Coordinates quantize to 0.5px (u32), the enemy
//  attack timer to 10ms (u8).
//
//  Coordinates are u32, not u16: the open world's arms are stacked by Y
//  (server/game/dungeon.js) and the map is ~66000px tall, well past what
//  0.5px-quantized u16 can hold (max 32767.5px) — anything deeper than
//  that (roughly the second half of the 'top' arm, and all of 'bottom'/
//  'right') used to have every x/y silently clamped to the same maxed-out
//  value on the wire, so those entities rendered pinned to one spot
//  (enemies looked frozen/"running in place") wherever they actually were
//  on the server, while still hitting players normally since the server's
//  own AI/attack logic never went through this codec at all.
//
//  Layout (little-endian):
//   u8  flags            bit0 = packet has players array
//   f64 t                server tick timestamp
//   [players] u8 count (capped well under 255 by PLAYER_CAP, Room.js), per entry:
//     u8  flags          bit0 = full
//     u16 seq            player handle
//     u32 x*2, u32 y*2
//     u8  facing         index into NC_FACING
//     i32 hp
//     u16 atkSeq
//     full only: str id, str username, u8 charType (255=none),
//                i32 maxHp, u8 pvpMode, str clanName, u8 clanIcon
//   [enemies] u16 count (a shared open world can hold hundreds), per entry:
//     u8  flags          bit0 = full
//     u16 idx            enemy handle
//     u32 x*2, u32 y*2
//     i32 hp
//     u8  aggro
//     u8  atkAnimTimer*100
//     full only: str id, str eid, i32 maxHp, str name, str color,
//                u8 size, u8 isBoss, f32 aggroR, u16 spd, u8 rlvl
//   str = u8 byteLength + UTF-8 bytes
// ─────────────────────────────────────────────────────────

const NC_FACING = ['front', 'back', 'left', 'right', 'frontright', 'frontleft', 'backleft', 'backright'];
// Appended, never reordered — indices are wire values other clients/servers
// may already have cached.
const NC_CHAR_TYPES = ['lev', 'deathknight', 'ranger', 'mage', 'warlock'];

const _ncEnc = new TextEncoder();
const _ncDec = new TextDecoder();
// Scratch buffer, grown on demand (never shrunk) — a shared open world can
// have hundreds of enemies in view at once (vs. a handful on the old
// per-floor maps this was originally sized for), and a burst of "full"
// entries (e.g. every enemy on a player's very first tick) is much bigger
// than a steady-state delta packet. A fixed-size buffer that a big encode
// overflows throws mid-tick and takes the whole Room loop down with it, so
// growth here has to be unconditional, not just a bigger constant.
let _ncBuf = new ArrayBuffer(65536);
let _ncDV  = new DataView(_ncBuf);
let _ncU8  = new Uint8Array(_ncBuf);
function _ncEnsure(o, extra) {
  const need = o + extra;
  if (need <= _ncBuf.byteLength) return;
  let cap = _ncBuf.byteLength;
  while (cap < need) cap *= 2;
  const nu8 = new Uint8Array(cap);
  nu8.set(_ncU8);
  _ncBuf = nu8.buffer;
  _ncU8 = nu8;
  _ncDV = new DataView(_ncBuf);
}
// Generous per-entry upper bound (id/eid/name/color/username/clanName are
// each at most a u8-length-prefixed string, i.e. 256 bytes; several of them
// plus the fixed numeric fields comfortably fit in 1200 bytes) — checked
// once before each entry instead of before every individual field write.
const _NC_ENTRY_HEADROOM = 1200;

// Decoder handle→id maps. Reset on floor change / game start — handles are
// scoped to the current room.
const _ncPIdMap = new Map(); // seq -> socketId
const _ncEIdMap = new Map(); // idx -> enemy id string

function resetNetCodecMaps() { _ncPIdMap.clear(); _ncEIdMap.clear(); }

// The length prefix is a single byte, so anything past 255 bytes has to be
// dropped here rather than written: `_ncU8[o] = b.length` silently keeps only
// the low 8 bits, and the decoder then reads the wrong length and misparses
// everything after this string in the packet — for every client the entry was
// sent to. Names are already normalised on the way in (_safeUsername,
// server/index.js), so this is the backstop for any other string field.
// Truncation is by whole bytes and can split a multi-byte character; the
// decoder's TextDecoder replaces the stray bytes rather than throwing.
function _ncWStr(o, s) {
  let b = _ncEnc.encode(s == null ? '' : String(s));
  if (b.length > 255) b = b.subarray(0, 255);
  _ncU8[o] = b.length;
  _ncU8.set(b, o + 1);
  return o + 1 + b.length;
}

// 0.5px quantization for a coordinate, clamped to what a u32 field can hold —
// see the file header for why this needs the full 32 bits, not 16.
function _ncQPos(v) { return Math.max(0, Math.min(4294967295, Math.round(v * 2))); }

// Caches the encoded ENEMIES segment across calls within the same tick —
// Room.js broadcasts the identical nearEnemies snapshot to every connected
// player, but this function used to re-encode it (including per-entry
// TextEncoder calls for "full" entries' string fields) from scratch on
// every single call. Measured at ~0.23ms/call with a realistic ~200-entry
// snapshot; at ~200 concurrent players that's ~46ms of pure duplicated work
// every tick, well past the 25ms tick budget on its own. `enemiesGen` (an
// opaque number Room.js bumps once per tick, right after rebuilding
// nearEnemies) is the cache-invalidation key — a plain reference-equality
// check on `enemies` doesn't work here since Room.js reuses the same array
// object (just cleared and refilled) every tick rather than allocating a
// fresh one. Callers that don't pass enemiesGen (or pass a fresh event
// number each time) simply never hit the cache, encoding normally.
let _ncEnemiesCacheGen = NaN;
let _ncEnemiesCacheBytes = null;

function encodeGameState(players, enemies, t, enemiesGen) {
  let o = 0;
  _ncEnsure(o, 16);
  _ncDV.setUint8(o, players ? 1 : 0); o += 1;
  _ncDV.setFloat64(o, t, true); o += 8;

  if (players) {
    // PLAYER_CAP (Room.js) keeps this well under 255 — u8 is safe.
    _ncDV.setUint8(o, Math.min(255, players.length)); o += 1;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      _ncEnsure(o, _NC_ENTRY_HEADROOM);
      const full = p.username !== undefined;
      _ncDV.setUint8(o, full ? 1 : 0); o += 1;
      _ncDV.setUint16(o, p.seq & 0xffff, true); o += 2;
      _ncDV.setUint32(o, _ncQPos(p.x), true); o += 4;
      _ncDV.setUint32(o, _ncQPos(p.y), true); o += 4;
      _ncDV.setUint8(o, Math.max(0, NC_FACING.indexOf(p.facing))); o += 1;
      _ncDV.setInt32(o, p.hp | 0, true); o += 4;
      _ncDV.setUint16(o, (p.atkSeq || 0) & 0xffff, true); o += 2;
      if (full) {
        o = _ncWStr(o, p.id);
        o = _ncWStr(o, p.username);
        _ncDV.setUint8(o, p.type ? Math.max(0, NC_CHAR_TYPES.indexOf(p.type)) : 255); o += 1;
        _ncDV.setInt32(o, p.maxHp | 0, true); o += 4;
        _ncDV.setUint8(o, p.pvpMode ? 1 : 0); o += 1;
        o = _ncWStr(o, p.clanName || '');
        _ncDV.setUint8(o, p.clanIcon || 0); o += 1;
      }
    }
  }

  if (enemiesGen !== undefined && enemiesGen === _ncEnemiesCacheGen && _ncEnemiesCacheBytes) {
    // Same enemies snapshot as the last call this tick — reuse the bytes
    // instead of re-running the (string-heavy) encode loop below.
    _ncEnsure(o, _ncEnemiesCacheBytes.length);
    _ncU8.set(_ncEnemiesCacheBytes, o);
    o += _ncEnemiesCacheBytes.length;
  } else {
    const enemiesStart = o;
    // u16 — a shared open world can have hundreds of enemies in view at once
    // (unlike the old per-floor maps this was originally u8-sized for).
    _ncEnsure(o, 2);
    _ncDV.setUint16(o, Math.min(65535, enemies.length), true); o += 2;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      _ncEnsure(o, _NC_ENTRY_HEADROOM);
      const full = e.eid !== undefined;
      _ncDV.setUint8(o, full ? 1 : 0); o += 1;
      _ncDV.setUint16(o, e.idx & 0xffff, true); o += 2;
      _ncDV.setUint32(o, _ncQPos(e.x), true); o += 4;
      _ncDV.setUint32(o, _ncQPos(e.y), true); o += 4;
      _ncDV.setInt32(o, e.hp | 0, true); o += 4;
      _ncDV.setUint8(o, e.aggro ? 1 : 0); o += 1;
      _ncDV.setUint8(o, Math.max(0, Math.min(255, Math.round((e.atkAnimTimer || 0) * 100)))); o += 1;
      if (full) {
        o = _ncWStr(o, e.id);
        o = _ncWStr(o, e.eid);
        _ncDV.setInt32(o, e.maxHp | 0, true); o += 4;
        o = _ncWStr(o, e.name);
        o = _ncWStr(o, e.color);
        _ncDV.setUint8(o, Math.max(0, Math.min(255, e.size | 0))); o += 1;
        _ncDV.setUint8(o, e.isBoss ? 1 : 0); o += 1;
        _ncDV.setFloat32(o, e.aggroR || 0, true); o += 4;
        _ncDV.setUint16(o, Math.max(0, Math.min(65535, e.spd | 0)), true); o += 2;
        _ncDV.setUint8(o, Math.max(0, Math.min(255, e.rlvl | 0))); o += 1;
      }
    }
    if (enemiesGen !== undefined) {
      _ncEnemiesCacheGen = enemiesGen;
      _ncEnemiesCacheBytes = _ncU8.slice(enemiesStart, o);
    }
  }
  // Copy — the scratch buffer is reused for the next recipient while
  // socket.io may still hold this payload for async transmission
  return _ncBuf.slice(0, o);
}

function decodeGameState(data) {
  const dv = ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
  const u8 = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);

  let o = 0;
  const flags = dv.getUint8(o); o += 1;
  const t = dv.getFloat64(o, true); o += 8;

  function rStr() {
    const len = u8[o]; o += 1;
    const s = _ncDec.decode(u8.subarray(o, o + len)); o += len;
    return s;
  }

  let players = null;
  if (flags & 1) {
    players = [];
    const n = dv.getUint8(o); o += 1;
    for (let i = 0; i < n; i++) {
      const f = dv.getUint8(o); o += 1;
      const seq = dv.getUint16(o, true); o += 2;
      const x = dv.getUint32(o, true) / 2; o += 4;
      const y = dv.getUint32(o, true) / 2; o += 4;
      const facing = NC_FACING[dv.getUint8(o)] || 'front'; o += 1;
      const hp = dv.getInt32(o, true); o += 4;
      const atkSeq = dv.getUint16(o, true); o += 2;
      if (f & 1) {
        const id = rStr();
        const username = rStr();
        const ti = dv.getUint8(o); o += 1;
        const maxHp = dv.getInt32(o, true); o += 4;
        const pvpMode = !!dv.getUint8(o); o += 1;
        const clanName = rStr() || null;
        const clanIcon = dv.getUint8(o) || null; o += 1;
        _ncPIdMap.set(seq, id);
        players.push({ id, username, type: ti === 255 ? null : NC_CHAR_TYPES[ti],
          x, y, facing, hp, maxHp, pvpMode, atkSeq, clanName, clanIcon });
      } else {
        const id = _ncPIdMap.get(seq);
        // Unknown handle (map lost) — skip; the periodic full refresh
        // re-establishes the mapping within ~2s
        if (id !== undefined)
          players.push({ id, x, y, facing, hp, atkSeq });
      }
    }
  }

  const enemies = [];
  const en = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < en; i++) {
    const f = dv.getUint8(o); o += 1;
    const idx = dv.getUint16(o, true); o += 2;
    const x = dv.getUint32(o, true) / 2; o += 4;
    const y = dv.getUint32(o, true) / 2; o += 4;
    const hp = dv.getInt32(o, true); o += 4;
    const aggro = !!dv.getUint8(o); o += 1;
    const atkAnimTimer = dv.getUint8(o) / 100; o += 1;
    if (f & 1) {
      const id = rStr();
      const eid = rStr();
      const maxHp = dv.getInt32(o, true); o += 4;
      const name = rStr();
      const color = rStr();
      const size = dv.getUint8(o); o += 1;
      const isBoss = !!dv.getUint8(o); o += 1;
      const aggroR = dv.getFloat32(o, true); o += 4;
      const spd = dv.getUint16(o, true); o += 2;
      const rlvl = dv.getUint8(o); o += 1;
      _ncEIdMap.set(idx, id);
      enemies.push({ id, eid, x, y, hp, maxHp, name, color, size, isBoss,
        aggro, aggroR, spd, rlvl, atkAnimTimer });
    } else {
      const id = _ncEIdMap.get(idx);
      if (id !== undefined)
        enemies.push({ id, x, y, hp, aggro, atkAnimTimer });
    }
  }

  return { players, enemies, t };
}

// ── Dungeon grid packing ─────────────────────────────────────────────────────
// The open-world grid is ~1000×1000 tiles (~1M cells) — sent raw as nested
// JSON arrays that would be a multi-MB payload. Packed 1 bit/cell (WALL=0,
// FLOOR=1) it's ~125KB, which socket.io ships as a binary attachment (no
// base64 inflation) instead of JSON.
function packGrid(grid, w, h) {
  const buf = Buffer.alloc(Math.ceil((w * h) / 8));
  let bit = 0;
  for (let y = 0; y < h; y++) {
    const row = grid[y];
    for (let x = 0; x < w; x++) {
      if (row[x]) buf[bit >> 3] |= (1 << (bit & 7));
      bit++;
    }
  }
  return buf;
}

function unpackGrid(packed, w, h) {
  const u8 = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
  const grid = new Array(h);
  let bit = 0;
  for (let y = 0; y < h; y++) {
    const row = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      row[x] = (u8[bit >> 3] >> (bit & 7)) & 1;
      bit++;
    }
    grid[y] = row;
  }
  return grid;
}

if (typeof module !== 'undefined')
  module.exports = { encodeGameState, decodeGameState, resetNetCodecMaps, packGrid, unpackGrid };
