---
name: liberty-econ-review
description: >
  Review any change to this game's items, inventory, currency or trading against the
  invariants that keep players from losing what they own. Use this whenever a change
  touches inventory/equipment/storage, GRAM or Liberty balances, the market, crafting,
  clan storage, loot drops, quest or VIP rewards, the save path (saveProgress /
  _sanitizeSavedStats / selectChar), or any handler that calls _commitServerItems,
  _invAdd, _invRemove or _applyGrant — and also when a player reports an item, a
  purchase or a balance disappearing. Reach for it even when the change looks small
  or the request is phrased as "just add an item"/"just a quick shop tweak": every
  item-loss bug in BUG_AUDIT.md was a one-line omission in a handler that looked fine.
---

# Item and currency review (Liberty)

## Why this exists

Every confirmed item-loss bug in this codebase had the same shape:

> a handler removed an item, or took payment for one, and **then** discovered it
> had nowhere to put it — by which point the listing was cancelled, the GRAM was
> spent, or the stack was already spliced.

None of them were exotic. They were single missing guards in handlers that read
perfectly well on their own. The checklist below is what catches them; it is
derived from real defects, and each rule names the one it came from so you can
judge whether it applies rather than following it blindly.

`BUG_AUDIT.md` in the repo root has the full findings with reproduction steps.
Read it if a rule here seems arbitrary — the reasoning is there.

## The architecture you are reviewing against

Four facts decide whether a change is safe. Establish them before reading the diff.

**1. The server owns every item grant.** Nothing a client sends can create an
item or raise an enhance level. Every grant goes through `_commitServerItems`,
which updates the live copy, bumps `_invRev`, persists, logs `inv:<reason>` and
pushes an authoritative `inventorySync` back. A change that grants an item
without going through it is wrong even if it happens to work.

**2. A client save may only ever SHRINK the item set.** `_itemCensus` counts
`inventory + equipment + storage` together as one multiset, keyed by `id` for
stackables and `id@enhance` for gear. `_censusOverflow` rejects any save whose
census grew. This is the anti-duplication invariant, and it is stronger than a
checksum because a checksum computed on the client is forged along with the data.

The corollary matters as much as the rule: **a shrinking save is accepted
silently.** Nothing downstream notices an item disappearing. That is why
destroying an item on a path that should have refused is invisible in production
unless it is logged.

**3. `invRev` orders saves, it does not authorise them.** The client echoes back
the last revision it was told. A mismatch means the save was composed before a
grant and its item fields are stale. It never proves entitlement — the client is
what supplies it.

**4. Anything after an `await` may belong to a different session.** Node does not
cancel a promise chain when a socket disconnects. A handler that read
`_lastStats.inventory` before an await and writes it after may be writing into a
session whose client is gone, while the account plays on a new socket. This is
the single most productive source of "предмет пропал" reports.

## Review checklist

Work through these against the diff. For each, the question to ask is in bold.

### 1. Does every item object carry its `slot`?

`isStackableItem` (shared/definitions.js) answers purely off `it.slot`. An item
passed around as a bare `{ id, qty }` reads as **non-stackable**, and every stack
rule then inverts: `_invRemove` takes the whole entry instead of `qty` units,
`_invAdd` refuses to merge into an existing stack, and a room check thinks a
stackable needs a fresh slot.

`_itemSlotOf` now resolves the slot from the catalog as a backstop, but do not
rely on it — pass the real catalog entry (`CRAFT_MATS.find(...)`, `ITEM_DEF.find(...)`).

*Came from:* depositing 5 осколки into clan storage deleted a stack of 5000.

### 2. Does the room check match what `_invAdd` actually does?

**Is `_invHasRoomFor` used, rather than a hand-rolled test?**

A stackable rides in for free **only when a stack of it already exists**. The
test `!isStackableItem(item) && inv.length >= SERVER_INV_MAX` looks equivalent
and is not: it waves through a stackable with no existing stack, which `_invAdd`
then refuses. Any hand-rolled variant of that test is a bug.

*Came from:* buying a stack of stones on a full inventory spent the GRAM, marked
the lot sold, paid the seller, and destroyed the item.

### 3. Is the irreversible step last?

**Does anything get spent, removed or marked sold before delivery is known to be
possible?**

The correct order is: check room → take the irreversible step → deliver. If
delivery can still fail after the irreversible step, there must be an explicit
unwind — refund the balance, put the listing back to `active`, return the
allocation to the clan.

"Log it and move on" is not an unwind. A log line does not give the player their
item back.

*Came from:* market buy/cancel, quest rewards, admin lot cancellation.

### 4. Is there an `await` between reading the inventory and writing it?

If yes, the handler needs **both**:

- `_itemOpBusy++` / `_itemOpBusy--` around the whole thing, so a `saveProgress`
  landing in the gap cannot replace `_lastStats` underneath it; and
- a cross-session guard — `activeSessions.get(authed.telegramId) !== socket.id`
  → redirect the grant through `_socketForTelegramId(...)` and `_applyGrant` /
  `_applyCraftResult`, or fall back to `_dbPushInventory`.

Compare against `craftGear` and `craftClassGear`, which have both. A handler that
awaits and has neither is the bug, not the exception.

*Came from:* `craftPet` was the only craft missing both.

### 5. Is `_invAdd`'s return value checked?

It returns `false` when there is no room. Ignoring it means the player is told
they received something they did not. Every grant path must report only what
actually landed.

*Came from:* boss drops printed "+1× Ящик" on a full inventory and granted nothing.

### 6. Is the item addressed by identity, not by array index?

The client's slot numbering and the server's diverge after any server-side splice
(craft materials, a market listing, a clan deposit) until the following
`inventorySync` arrives. A destructive handler that indexes the server array with
a client-supplied index destroys whatever slid into that slot.

Use `_resolveInvIdx(inv, idx, id, enhance)` — index as a hint, identity as truth.

*Came from:* burning a common could destroy a legendary.

### 7. Do partial failures give the goods back?

A loop that grants several things and `continue`s past the ones it cannot deliver
loses them, because the all-or-nothing rollback only fires when *nothing* landed.
Collect what failed and return it to wherever it came from.

*Came from:* clan storage claim silently dropped a shard kind.

### 8. Is the reward written before the item is destroyed?

Destroy-then-await means a failed write (DB blip, exhausted pool) burns the item
for nothing. Award first, re-validate the item after the await, then destroy.
Points credited for a burn that did not happen is a far better failure than an
item destroyed for points that were never credited.

*Came from:* `seasonBurn` / `seasonBurnAll`.

### 9. Do scratch copies actually copy?

`[...inv]` copies the array and **shares every item object**. A `existing.qty +=`
on that "copy" lands in the live inventory immediately — including on paths that
then bail out with "nothing was consumed". Clone the entries:
`inv.map(i => (i && typeof i === 'object' ? { ...i } : i))`.

*Came from:* `claimVipRewards`' out-of-room refusal leaked quantity.

### 10. Does a new save field pass through the sanitizer?

`_sanitizeSavedStats` is the only thing standing between an arbitrary client blob
and the stored document. A new field added to `_buildSaveStats` (js/network.js)
and not handled there goes into the database exactly as sent — any keys, any
size, any values.

Decide which of the three it is:

- **server-owned** (balances, VIP, season, `specialQuestsDone`) → `delete` it, so
  the server's own targeted write is the only source;
- **client-owned but bounded** (`potionBag`, `skillLevels`, `buffs`) → whitelist
  keys and clamp values;
- **derived** (`baseAtk`, `xpNext`) → recompute from level, never trust.

### 11. Would renaming a catalog id destroy items?

`_canonSavedItem` returns `null` for an unknown id, the sanitizer filters it out,
and — because a shrinking save is legitimate — every copy is silently gone. Any
change that renames or removes an entry in `ITEM_DEF`/`CRAFT_MATS`/`BOX_DEF`
needs a line in `_ITEM_ID_ALIASES` mapping old → new.

## How to verify, not just read

Run the regression check — it is fast, needs no server and no database:

```bash
node dev/item-loss-check.js     # 68 checks
```

Useful greps when reviewing a diff:

```bash
# handlers that await while holding an inventory, without the busy guard
grep -n "safeOn('.*async" server/index.js

# hand-rolled room checks that should be _invHasRoomFor
grep -n "isStackableItem(.*).*SERVER_INV_MAX" server/index.js

# item objects built without a slot
grep -n "removeItems:\|addItems:" server/index.js
```

If the change adds a new invariant or a new failure mode, add a case to
`dev/item-loss-check.js`. It lifts the real functions out of `server/index.js` by
source text and runs them against the live catalog, so a check written there
keeps working as the code moves and fails loudly if a symbol is renamed.

## Reporting

Lead with the verdict, then the findings, most severe first. For each finding
give the file and symbol (not just a line number — those rot), what breaks, and
the concrete sequence that triggers it. Distinguish clearly between:

- **loss** — the player ends up with less than they should (always the priority);
- **duplication** — the player ends up with more;
- **desync** — the two copies disagree but nothing is created or destroyed.

Desync is worth reporting and worth fixing, but do not rank it with the other two.

If the diff is clean, say so plainly and name what you checked, so the next
reviewer knows which of the eleven questions above were already answered.
