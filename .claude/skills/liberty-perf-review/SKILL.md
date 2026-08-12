---
name: liberty-perf-review
description: >
  Performance work on this game — frame rate, GC pressure, tick time, latency,
  bandwidth. Use this whenever the task involves profiling or optimising the client
  frame loop (js/game.js, js/pixi-world.js, js/sprites.js), the server tick or
  broadcast (server/game/Room.js), the binary codec (shared/netcodec.js), or the
  socket layer — and whenever someone reports lag, stutter, low FPS, high ping,
  "тормозит", "лагает", or asks about object pooling, allocations, delta compression,
  interpolation or update rates. Reach for it BEFORE proposing any optimisation:
  it carries measured numbers for this codebase, including three plausible-sounding
  fixes that were benchmarked and turned out to be regressions on V8.
---

# Performance work (Liberty)

## Read this before proposing anything

This codebase has had three performance passes (`AUDIT-PERF.md`, `AUDIT-NET.md`,
`PERF_AUDIT.md`). The cheap wins are gone. What is left is a small set of real
constraints and a large set of plausible-sounding changes that measurement shows
would make things **worse**.

So the rule here is not "optimise carefully". It is: **produce a number before
you produce a patch.** An optimisation without a before/after measurement is not
an optimisation, it is a guess with a diff attached.

## Measured facts about this codebase

Do not re-derive these. They cost real time to establish and they are all
reproducible.

### The client is not CPU-bound

The built-in overlay (`_drawPerf`, js/game.js) measured on a real phone:
**0.8 ms in `update()` and 1.1 ms in `render()` against a 33 ms frame** — under
2 ms of budget used, roughly 15× headroom. The client is limited by vsync, not by
work. Micro-optimising the frame loop cannot produce a frame.

If someone reports low FPS, the first move is to read that overlay on the actual
device, not to start editing the loop.

### V8 is not the CLR — object pooling here is a pessimisation

Benchmarked at the real broadcast rate (150 players × 45 records × 20 casts/s =
135,000 short-lived objects per second):

```
fresh object literal per record (current code)
  0.48% of one core, GC events: 0, total pause: 0.0 ms
pooled record, fields overwritten
  0.54% of one core, GC events: 0, total pause: 0.0 ms
```

**Zero garbage collections, and the pool was 12% slower.** Young-generation
scavenge cost is proportional to *surviving* objects, not allocated ones — dead
objects are free. Pooled records live forever, get promoted to old space, and pay
a write barrier on every field assignment.

This is the single most common bad suggestion in this codebase's problem space,
because the Unity/C# instinct is correct there and inverted here. `Room.js` does
pool the `{op, d2}` candidate slots, and that is fine — but do not extend pooling
to the per-cast payload records.

### Caching per-frame strings is a pessimisation

```
`${dir}-run` template literal          20.5 ms
Map.get(dir + "|run")                 416.5 ms
null-proto object lookup              337.3 ms
```

**The template literal is 16–20× faster than any cache.** V8 builds it as a
cons-string — a pointer to two pieces, no copying. Building a lookup key forces
the string to materialise and be hashed, which costs more than the concatenation
ever did.

### `Math.hypot` is genuinely slow — and it does not matter here

```
Math.hypot(dx, dy)              24.6 M ops/s
Math.sqrt(dx*dx + dy*dy)       427.7 M ops/s     (17.4× faster)
dx*dx + dy*dy < r*r            478.1 M ops/s
```

The ratio is dramatic. The absolute contribution is not: `dist()` is called
roughly 10–20 times per frame, so the difference is about **0.05 ms per second**.

Worth fixing as hygiene when touching those lines — most calls are threshold
comparisons where the square root is not needed at all, and the codebase already
does this correctly in the target search. Not worth a dedicated change, and not
something to claim will improve frame rate.

### What is already done, so do not "discover" it again

- In-place list compaction (`projs[j++] = projs[i]`) instead of `filter`/`splice`.
- Pools for sprites, text and candidate slots.
- Memoised room lookup (`_getRoomAt`).
- Squared distances in the target search and in projectile collision.
- No DOM lookups in the frame path.
- Per-recipient delta compression, position epsilon, empty-packet suppression.
- Snapshot interpolation, 110 ms buffer.
- Change-gated, `volatile`, ~30 Hz position sends.
- Adaptive quality tier below 20 fps.

## Where the real costs are

Ranked by measured or previously-measured impact. The top four all predate this
skill and were deferred deliberately, not overlooked.

1. **One process = one core.** Ceiling around 250–300 concurrent players, and
   capacity is not instrumented. Everything else in this file combined is smaller
   than this. The first step is not optimisation but a metric: event-loop lag and
   tick time under load.
2. **Coordinates are `setUint32` in the codec** (`shared/netcodec.js`) — 4 bytes
   per axis, 8 per entity. The world fits in `u16`. Roughly 20–25% of the
   outbound channel, and it is a local change in one file.
3. **Two WebSocket frames per binary event** — socket.io sends a JSON envelope
   plus the binary attachment; about 79% of the bytes are envelope.
4. **No lag compensation in PvP.** Hits resolve against positions at receive
   time, with no rewind by the attacker's RTT. Felt as "попал, но не засчитало".
5. **Particles re-tessellate every frame.** `_updateParticles` clears its
   `Graphics` and redraws up to 200 circles per frame, so PIXI re-tessellates and
   re-uploads all of it. **This has not been measured on a device** — measure
   before acting, and remember the 15× headroom above.
6. **No network telemetry.** The server knows nothing about client loss or
   jitter. Worth doing before any adaptive-quality work, because measurement is
   cheaper than adaptation and tells you whether adaptation is needed.

## How to measure

In-game, on the device that has the problem — the overlay shows `upd`, `rnd`,
`prt`, `qlty`, fps. That is the fastest honest signal for any FPS complaint.

Server and network, from `dev/` (these need `npm install`):

```bash
node dev/netprobe.js       # per-event traffic accounting, both directions
node dev/loadtest.js       # synthetic clients, CPU and tick timing
node dev/snapshot-check.js # interpolation / repeated-position analysis
node dev/roombench.js      # room tick cost in isolation
node dev/profsum.js        # profile summary
curl localhost:3000/health # tick timings
```

For a micro-question (is X faster than Y in V8?), write a throwaway benchmark and
run it under the same Node the server uses. Warm the JIT first, use
`process.hrtime.bigint()`, and when the question is about garbage, measure GC
directly with `PerformanceObserver` on `entryTypes: ['gc']` rather than inferring
it from wall time — that distinction is what disproved the pooling hypothesis.

## Reporting

Rank findings by **measured** impact, and say plainly when something is
unmeasured. A finding with a dramatic ratio and a negligible absolute effect
should be reported as exactly that — the `Math.hypot` entry above is the model:
state the ratio, then state that it contributes 0.05 ms/s, then let the reader
decide.

Two habits worth keeping:

- **Report negative results.** "I benchmarked pooling and it was slower" is more
  valuable than silence, because it stops the next person spending a day on it.
  When you disprove one of your own hypotheses, say so explicitly rather than
  quietly dropping it.
- **Separate "already optimal" from "not a bottleneck".** They lead to different
  decisions: the first means leave it alone, the second means it might matter
  later at higher load.

If a change is proposed, it needs a before/after number from one of the tools
above. If the number cannot be obtained in the current environment, say which
tool would produce it and what result would justify the change.
