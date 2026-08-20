'use strict';
// Admin: granting gold, GRAM or Liberty to one player or to everybody.
//
// Both routes have to reach a recipient who may be online right now, whose live
// session holds the authoritative copy — writing only to the database would be
// overwritten by that session's next save.
const PlayerModel = require('../models/Player');
const REQUIRED_DEPS = ['adminAuth', 'io', 'logPlayer', 'activeSessions', '_incBalance'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`give: missing deps: ${missing.join(', ')}`);
  const { adminAuth, io, logPlayer, activeSessions, _incBalance } = deps;

  app.post('/admin/player/:tid/give', adminAuth, async (req, res) => {
    try {
      // Validated before anything is added: an unparseable figure used to reach
      // Mongo as NaN, and a savedData.gold of NaN breaks the client's whole
      // money UI with no obvious cause.
      const _amt = v => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const gold  = _amt((req.body || {}).gold);
      const nexum = _amt((req.body || {}).nexum);
      const gram  = _amt((req.body || {}).gram);
      // Skill points (очки навыка) — same field give-all already grants in
      // bulk (savedData.bonusSP); this is its single-account counterpart.
      // Truncated like give-all's own _amt does: a fractional skill point
      // means nothing to skillPointBudget.
      const sp    = Math.trunc(_amt((req.body || {}).sp));
      if (!gold && !nexum && !gram && !sp) return res.status(400).json({ error: 'Нечего выдавать' });
      const p = await PlayerModel.findOne({ telegramId: req.params.tid });
      if (!p) return res.status(404).json({ error: 'Not found' });
      const saved = p.savedData || {};
      // Gold and skill points, unlike gram/nexum, have no server-side live
      // cache — both ride the client's save blob. Writing them straight to the
      // DB for a player who is online meant their next autosave (up to 60s
      // later) overwrote the grant with whatever figure their client still
      // held, and it silently vanished. Route both through the live session
      // when there is one, via the same helper /admin/give-all already uses
      // for a mass grant of this exact pair.
      const _liveSock = io.sockets.sockets.get(activeSessions.get(String(req.params.tid)) || '');
      const _giveLive = (gold || sp) ? _liveSock?.data?._adminGiveGoldSP : null;
      if (gold) saved.gold    = (saved.gold || 0) + gold;
      if (sp)   saved.bonusSP = (saved.bonusSP || 0) + sp;
      // Both balances move by $inc against the live document — the player may be
      // online and earning while the admin types, and neither side should
      // overwrite the other. A negative figure is a valid way to take money back,
      // which is why this uses _incBalance and not _spendBalance.
      if (nexum) await _incBalance(p.telegramId, 'nexumBalance', nexum);
      if (gram) {
        const newG = await _incBalance(p.telegramId, 'gramBalance', gram);
        if (newG !== null) io.to(`tg_${p.telegramId}`).emit('gramBalanceUpdate', { balance: newG });
      }
      // Targeted $set on just the touched fields — a full-document save from
      // this snapshot would revert any other savedData field this account's
      // own gameplay autosave wrote in the same window.
      // Only gold/bonusSP go through $set here — the two real balances were
      // already moved atomically above and must never be written as an absolute.
      const _giveSet = {};
      // Gold/SP handled by the live session when the player is online (see
      // above); only write them here when nobody is holding a newer copy in
      // memory.
      if (gold && !_giveLive) _giveSet['savedData.gold']    = saved.gold;
      if (sp   && !_giveLive) _giveSet['savedData.bonusSP'] = saved.bonusSP;
      if (Object.keys(_giveSet).length) await PlayerModel.updateOne({ _id: p._id }, { $set: _giveSet });
      const _liveResult = _giveLive ? await _giveLive(gold, sp) : null;
      io.to(`tg_${p.telegramId}`).emit('adminGive', {
        gold, nexum, gram, sp,
        newGold: _liveResult ? _liveResult.gold : undefined,
        newBonusSP: _liveResult ? _liveResult.bonusSP : undefined,
      });
      logPlayer(p.telegramId, p.username, 'admin_give', { gold, nexum, gram, sp });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Same grant as above, applied to every registered account at once — the
  // "give to all" button pair on the dashboard. Online accounts go through
  // their live session (socket.data._adminGiveGoldSP, same reasoning as
  // _adminGiveGold above: their own 60s autosave would otherwise revert a
  // DB-only write); everyone else gets a straight $inc.
  app.post('/admin/give-all', adminAuth, async (req, res) => {
    try {
      const _amt = v => {
        const n = Math.trunc(Number(v));
        return Number.isFinite(n) ? n : 0;
      };
      const gold = _amt((req.body || {}).gold);
      const sp   = _amt((req.body || {}).sp);
      if (!gold && !sp) return res.status(400).json({ error: 'Нечего выдавать' });

      const liveIds = [];
      for (const s of io.sockets.sockets.values()) {
        if (!s.data?.telegramId || typeof s.data._adminGiveGoldSP !== 'function') continue;
        liveIds.push(s.data.telegramId);
        const result = await s.data._adminGiveGoldSP(gold, sp);
        s.emit('adminGive', {
          gold, nexum: 0, gram: 0, sp,
          newGold: result ? result.gold : undefined,
          newBonusSP: result ? result.bonusSP : undefined,
        });
      }

      // Legacy accounts can still have savedData: null — a dotted $inc through
      // a null parent throws (see the season-points route above), so it has to
      // be normalised first, same as there.
      const offlineFilter = liveIds.length ? { telegramId: { $nin: liveIds } } : {};
      await PlayerModel.updateMany({ ...offlineFilter, savedData: null }, { $set: { savedData: {} } });
      const inc = {};
      if (gold) inc['savedData.gold'] = gold;
      if (sp)   inc['savedData.bonusSP'] = sp;
      const r = await PlayerModel.updateMany(offlineFilter, { $inc: inc });

      console.log(`[admin] give-all: gold=${gold} sp=${sp} — ${liveIds.length} online, ${r.modifiedCount || 0} offline`);
      res.json({ ok: true, online: liveIds.length, offline: r.modifiedCount || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
