'use strict';
// Admin: the item catalog and granting items into a player's inventory.
// Everything granted here goes through the same _invAdd every other server-side
// grant uses, so a full inventory refuses the gift instead of destroying it.
const PlayerModel = require('../models/Player');
const { _catalogBase, _SANITIZE_MAX } = require('../anticheat');
const { _invAdd } = require('../inventory');
const {
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCE_MAX, ENHANCEABLE_SLOTS, isStackableItem,
} = require('../../shared/definitions');
const REQUIRED_DEPS = ['adminAuth', 'activeSessions', 'io', 'logPlayer'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`items: missing deps: ${missing.join(', ')}`);
  const { adminAuth, activeSessions, io, logPlayer } = deps;

  // ── Admin: player inventory / equipment ──────────────────────────────────────
  // The whole catalog an admin can hand out, in the same shape the game itself
  // stores items in, so the panel can render real icons rather than raw ids.
  app.get('/admin/items', adminAuth, (req, res) => {
    const pack = d => ({
      id: d.id, name: d.name, img: d.img || null, slot: d.slot,
      rarity: d.rarity || 'common', forClass: d.forClass || null,
      stackable: isStackableItem(d), enhanceable: ENHANCEABLE_SLOTS.has(d.slot),
    });
    res.json({ items: [...ITEM_DEF, ...CRAFT_MATS, ...BOX_DEF].map(pack) });
  });

  // Applies an inventory/equipment edit. The player may be online, in which case
  // their socket holds the authoritative copy (_lastStats) and its next autosave
  // would simply overwrite whatever we wrote to the DB — so when a live session
  // exists the edit goes through it (socket.data._adminApplyItems, which updates
  // _lastStats, persists, and pushes the result to the client) and only falls
  // back to a direct DB write when the account is offline.
  app.post('/admin/player/:tid/items', adminAuth, async (req, res) => {
    try {
      const { action, itemId, slot, index, qty, enhance } = req.body || {};
      const p = await PlayerModel.findOne({ telegramId: req.params.tid });
      if (!p) return res.status(404).json({ error: 'Not found' });

      const liveSocket = io.sockets.sockets.get(activeSessions.get(String(req.params.tid)) || '');
      const live = liveSocket && liveSocket.data && liveSocket.data._adminApplyItems;

      const saved = p.savedData || {};
      // Work on the live copy when there is one, so a concurrent autosave can't
      // race this edit; otherwise on the DB snapshot.
      const base = live ? liveSocket.data._adminReadItems() : {
        inventory: Array.isArray(saved.inventory) ? saved.inventory : [],
        equipment: (saved.equipment && typeof saved.equipment === 'object') ? saved.equipment : {},
      };
      const inv = base.inventory.slice();
      const eq  = { ...base.equipment };

      if (action === 'add') {
        const catalogItem = _catalogBase(itemId);
        if (!catalogItem) return res.status(400).json({ error: 'Unknown item' });
        const item = { ...catalogItem };
        if (ENHANCEABLE_SLOTS.has(item.slot)) {
          const e = Math.floor(Number(enhance));
          item.enhance = (Number.isFinite(e) && e >= 0 && e <= ENHANCE_MAX) ? e : 0;
        }
        const n = Math.max(1, Math.min(Math.floor(Number(qty)) || 1, _SANITIZE_MAX.qty));
        if (isStackableItem(item)) {
          item.qty = n;
          if (!_invAdd(inv, item)) return res.status(400).json({ error: 'Инвентарь полон' });
        } else {
          // Non-stackables occupy one slot each — add them one at a time so the
          // capacity check is real rather than counting a single push as n items.
          for (let i = 0; i < n; i++) {
            if (!_invAdd(inv, { ...item })) return res.status(400).json({ error: 'Инвентарь полон' });
          }
        }
      } else if (action === 'removeInv') {
        const i = Math.floor(Number(index));
        if (!(i >= 0 && i < inv.length)) return res.status(400).json({ error: 'Bad index' });
        const entry = inv[i];
        const take = Math.max(1, Math.floor(Number(qty)) || 1);
        const have = entry && entry.qty ? entry.qty : 1;
        if (isStackableItem(entry || {}) && have > take) entry.qty = have - take;
        else inv.splice(i, 1);
      } else if (action === 'removeEq') {
        if (!slot || !eq[slot]) return res.status(400).json({ error: 'Слот пуст' });
        delete eq[slot];
      } else {
        return res.status(400).json({ error: 'Unknown action' });
      }

      if (live) {
        // Refused only while that session has an item op in flight — see
        // _adminApplyItems. Saying so beats reporting a write that is about to
        // be stamped away by it.
        if (!await liveSocket.data._adminApplyItems(inv, eq)) {
          return res.status(409).json({ error: 'Игрок сейчас в другой операции с предметами — повторите' });
        }
      } else {
        await PlayerModel.updateOne({ _id: p._id },
          { $set: { 'savedData.inventory': inv, 'savedData.equipment': eq } });
      }
      logPlayer(p.telegramId, p.username, 'admin_items', { action, itemId, slot, index, qty, enhance });
      res.json({ ok: true, inventory: inv, equipment: eq, online: !!live });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
