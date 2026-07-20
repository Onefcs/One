// ─────────────────────────────────────────────────────────
//  Binary codec for gameState packets (shared client/server)
//
//  JSON gameState entries cost ~70-130 bytes each; the binary form is
//  ~11 bytes for a slim player and ~12 for a slim enemy (8-10x less),
//  plus far cheaper parsing than JSON on mobile.
//
//  Entries reference entities by small numeric handles (player _seq /
//  enemy _idx); the string ids travel only inside FULL entries, and the
//  decoder keeps handle→id maps that the periodic full refresh repairs
//  if they ever diverge. Coordinates quantize to 0.5px (u16), the enemy
//  attack timer to 10ms (u8).
//
//  Layout (little-endian):
//   u8  flags            bit0 = packet has players array
//   f64 t                server tick timestamp
//   [players] u8 count, then per entry:
//     u8  flags          bit0 = full
//     u16 seq            player handle
//     u16 x*2, u16 y*2
//     u8  facing         index into NC_FACING
//     i32 hp
//     u16 atkSeq
//     full only: str id, str username, u8 charType (255=none),
//                i32 maxHp, u8 pvpMode
//   [enemies] u8 count, then per entry:
//     u8  flags          bit0 = full
//     u16 idx            enemy handle
//     u16 x*2, u16 y*2
//     i32 hp
//     u8  aggro
//     u8  atkAnimTimer*100
//     full only: str id, str eid, i32 maxHp, str name, str color,
//                u8 size, u8 isBoss, f32 aggroR, u16 spd
//   str = u8 byteLength + UTF-8 bytes
// ─────────────────────────────────────────────────────────

const NC_FACING = ['front', 'back', 'left', 'right'];
const NC_CHAR_TYPES = ['warrior', 'archer', 'mage', 'priest', 'assasin'];

const _ncEnc = new TextEncoder();
const _ncDec = new TextDecoder();
const _ncBuf = new ArrayBuffer(65536);
const _ncDV  = new DataView(_ncBuf);
const _ncU8  = new Uint8Array(_ncBuf);

// Decoder handle→id maps. Reset on floor change / game start — handles are
// scoped to the current room.
const _ncPIdMap = new Map(); // seq -> socketId
const _ncEIdMap = new Map(); // idx -> enemy id string

function resetNetCodecMaps() { _ncPIdMap.clear(); _ncEIdMap.clear(); }

function _ncWStr(o, s) {
  const b = _ncEnc.encode(s == null ? '' : String(s));
  _ncU8[o] = b.length;
  _ncU8.set(b, o + 1);
  return o + 1 + b.length;
}

function _ncQ16(v) { return Math.max(0, Math.min(65535, Math.round(v * 2))); }

function encodeGameState(players, enemies, t) {
  let o = 0;
  _ncDV.setUint8(o, players ? 1 : 0); o += 1;
  _ncDV.setFloat64(o, t, true); o += 8;

  if (players) {
    _ncDV.setUint8(o, players.length); o += 1;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const full = p.username !== undefined;
      _ncDV.setUint8(o, full ? 1 : 0); o += 1;
      _ncDV.setUint16(o, p.seq & 0xffff, true); o += 2;
      _ncDV.setUint16(o, _ncQ16(p.x), true); o += 2;
      _ncDV.setUint16(o, _ncQ16(p.y), true); o += 2;
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

  _ncDV.setUint8(o, enemies.length); o += 1;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const full = e.eid !== undefined;
    _ncDV.setUint8(o, full ? 1 : 0); o += 1;
    _ncDV.setUint16(o, e.idx & 0xffff, true); o += 2;
    _ncDV.setUint16(o, _ncQ16(e.x), true); o += 2;
    _ncDV.setUint16(o, _ncQ16(e.y), true); o += 2;
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
      const x = dv.getUint16(o, true) / 2; o += 2;
      const y = dv.getUint16(o, true) / 2; o += 2;
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
  const en = dv.getUint8(o); o += 1;
  for (let i = 0; i < en; i++) {
    const f = dv.getUint8(o); o += 1;
    const idx = dv.getUint16(o, true); o += 2;
    const x = dv.getUint16(o, true) / 2; o += 2;
    const y = dv.getUint16(o, true) / 2; o += 2;
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
      _ncEIdMap.set(idx, id);
      enemies.push({ id, eid, x, y, hp, maxHp, name, color, size, isBoss,
        aggro, aggroR, spd, atkAnimTimer });
    } else {
      const id = _ncEIdMap.get(idx);
      if (id !== undefined)
        enemies.push({ id, x, y, hp, aggro, atkAnimTimer });
    }
  }

  return { players, enemies, t };
}

if (typeof module !== 'undefined')
  module.exports = { encodeGameState, decodeGameState, resetNetCodecMaps };
