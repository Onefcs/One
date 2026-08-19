#!/usr/bin/env node
'use strict';
// What a watcher's SCREEN actually does while another player runs past in a
// straight line at constant speed.
//
// Real Room, real _tick(), real binary codec. The runner's client is modelled
// as js/game.js + js/network.js behave (netSendMove() once per rendered frame,
// refusing to send inside _MOVE_SEND_MS); the watcher's render loop and
// interpolation are the ones from js/game.js, replayed over the packets the
// Room actually emitted.
//
// A perfectly smooth result is: every rendered frame advances the runner by
// the same number of pixels. Anything else is the twitch.
//
// Reports both readings side by side: `before_castStamped` times the buffer by
// the cast timestamp (what the client did before the ages section existed) and
// `after_sampleStamped` by the position's own sample time. speedSwingPct is the
// headline — how much the runner's rendered speed varies as a share of their
// true speed, on a link with no latency and no loss at all.
//
//   node dev/jitter-check.js [seconds]

const path = require('path');
const ROOT = path.join(__dirname, '..');
const Room = require(path.join(ROOT, 'server', 'game', 'Room.js'));
const { FLOOR_IDS } = require(path.join(ROOT, 'server', 'game', 'floors.js'));
const { decodeGameState, resetNetCodecMaps } = require(path.join(ROOT, 'shared', 'netcodec.js'));

const SECS = Number(process.argv[2] || 8);
const MOVE_SEND_MS = 25;
const SPEED = 170;
const TICK_MS = 25;
const WATCH_FPS = 60;
const SNAP_MAX = 10;      // js/network.js _SNAP_MAX
const INTERP_MS = 110;    // js/network.js steady-state _interpMs

const CASES = [
  { name: '60Hz display -> 60fps sender', fps: 60 },
  { name: '90Hz display -> 45fps sender', fps: 45 },
  { name: '144Hz display -> 72fps sender', fps: 72 },
  { name: '40fps sender', fps: 40 },
  { name: '33fps sender', fps: 33 },
  { name: '30fps sender', fps: 30 },
  { name: '24fps sender', fps: 24 },
];

// Capture the packet stream one watcher receives for one runner.
function capture(fps) {
  resetNetCodecMaps();
  const packets = [];
  const watcherSock = {
    connected: true,
    volatile: { emit: (ev, buf) => { if (ev === 'gameState') packets.push({ at: Date.now(), buf: buf.slice(0) }); } },
    emit: () => {},
  };
  const runnerSock = { connected: true, volatile: { emit: () => {} }, emit: () => {} };
  const sockets = new Map([['watcher', watcherSock], ['runner', runnerSock]]);
  const io = { to: () => ({ emit: () => {} }), sockets: { sockets: { get: id => sockets.get(id) } } };

  const room = new Room(FLOOR_IDS.hub, io, {}, null);
  const spawn = room._dungeon.spawn;
  room.addPlayer('watcher', 'watcher', null, null, 0, '1000001');
  room.addPlayer('runner', 'runner', null, null, 0, '1000002');
  room.setPlayerChar('watcher', 'lev', null);
  room.setPlayerChar('runner', 'lev', null);
  if (room._interval) { clearInterval(room._interval); room._interval = null; }

  const W = room.players.get('watcher'), R = room.players.get('runner');
  W._socket = watcherSock; R._socket = runnerSock;
  W.x = spawn.x; W.y = spawn.y;
  R.x = spawn.x + 100; R.y = spawn.y;

  const frameMs = 1000 / fps;
  let simT = 0, nextFrame = 0, nextTick = TICK_MS;
  let lastMoveSend = -1e9, sentX = null;
  let rx = R.x;

  const realNow = Date.now;
  const t0 = realNow();
  Date.now = () => t0 + simT;
  try {
    while (simT < SECS * 1000) {
      if (nextFrame <= nextTick) {
        simT = nextFrame; nextFrame += frameMs;
        rx += SPEED * (frameMs / 1000);
        const now = Date.now();
        if (now - lastMoveSend >= MOVE_SEND_MS) {
          if (sentX === null || Math.abs(rx - sentX) > 0.5 || now - lastMoveSend >= 1000) {
            lastMoveSend = now; sentX = rx;
            room.updatePlayerPos('runner', Math.round(rx * 2) / 2, R.y, 'right', true);
          }
        }
      } else {
        simT = nextTick; nextTick += TICK_MS;
        // Keep the watcher alongside, or the runner crosses PLAYER_AOI_R
        // (600px) a few seconds in and simply stops being streamed — which
        // would be measuring the AOI edge, not the interpolation.
        W.x = rx - 100; W.y = R.y;
        room._tick();
      }
    }
  } finally { Date.now = realNow; }
  return { packets, t0 };
}

// Replay through the watcher's buffer + interpolation (js/network.js gameState
// handler, js/game.js interpolation loop). Zero network delay, so anything
// uneven here is the protocol, not the link.
function replay(packets, t0, useAge) {
  const events = packets.map(p => ({ at: p.at, st: decodeGameState(p.buf) }));
  let buf = [];
  const frameMs = 1000 / WATCH_FPS;
  const rendered = [];
  let lastRenderT = 0;
  let ei = 0;

  for (let simT = 0; simT <= (events[events.length - 1].at - t0); simT += frameMs) {
    const nowAbs = t0 + simT;
    // Deliver every packet that has arrived by this frame.
    while (ei < events.length && events[ei].at <= nowAbs) {
      const { st } = events[ei++];
      if (!st.players) continue;
      for (const p of st.players) {
        if (p.id !== 'runner') continue;
        const sampleT = (useAge && p.ageMs !== undefined) ? st.t - p.ageMs : st.t;
        const prev = buf[buf.length - 1];
        let sT = sampleT;
        if (prev) {
          if (p.x === prev.x && p.y === prev.y) sT = st.t;
          else if (sT <= prev.t) sT = prev.t + 1;
        }
        buf.push({ x: p.x, t: sT });
        if (buf.length > SNAP_MAX) buf.shift();
      }
    }
    // js/game.js interpolation loop.
    let renderT = nowAbs - INTERP_MS;
    if (renderT < lastRenderT) renderT = lastRenderT;
    lastRenderT = renderT;
    if (buf.length < 2) continue;
    let i = buf.length - 2;
    while (i > 0 && buf[i].t > renderT) i--;
    const s0 = buf[i], s1 = buf[i + 1];
    const span = s1.t - s0.t;
    let x;
    if (span < 1) x = s1.x;
    else if (renderT <= s1.t) x = s0.x + (s1.x - s0.x) * Math.max(0, (renderT - s0.t) / span);
    else x = s1.x + ((s1.x - s0.x) / span) * Math.min(renderT - s1.t, 150);
    rendered.push(x);
  }

  // Per-frame displacement — what the eye reads as speed.
  const steps = [];
  for (let i = 1; i < rendered.length; i++) steps.push(rendered[i] - rendered[i - 1]);
  const warm = steps.slice(20, -5);           // drop buffer fill-up / tail
  const mean = warm.reduce((a, b) => a + b, 0) / warm.length;
  const sd = Math.sqrt(warm.reduce((a, b) => a + (b - mean) ** 2, 0) / warm.length);
  const trueStep = SPEED / WATCH_FPS;
  return {
    truePxPerFrame: +trueStep.toFixed(2),
    meanPxPerFrame: +mean.toFixed(2),
    minPxPerFrame: +Math.min(...warm).toFixed(2),
    maxPxPerFrame: +Math.max(...warm).toFixed(2),
    // The headline: rendered speed swing as a share of true speed.
    speedSwingPct: +((Math.max(...warm) - Math.min(...warm)) / trueStep * 100).toFixed(1),
    jitterSdPct: +(sd / trueStep * 100).toFixed(1),
  };
}

const out = {};
for (const c of CASES) {
  const { packets, t0 } = capture(c.fps);
  out[c.name] = {
    before_castStamped: replay(packets, t0, false),
    after_sampleStamped: replay(packets, t0, true),
  };
}
console.log(JSON.stringify(out, null, 2));
