'use strict';
// Admin: season points. Awarding and revoking by hand, which is why every
// movement is written to the player log — these rows decide who takes a prize,
// so they are the ones an appeal gets checked against.
const PlayerModel = require('../models/Player');
const REQUIRED_DEPS = ['adminAuth', 'io', 'logPlayer'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`season: missing deps: ${missing.join(', ')}`);
  const { adminAuth, io, logPlayer } = deps;

  // ── Admin: season points ─────────────────────────────────────────────────────
  // Hands out (or takes back) season points by hand — for compensating an award
  // that failed, and for anything else the automatic paths can't cover.
  // $inc against the live document for the same reason the balances use it: the
  // player may be earning while the admin types, and neither side should
  // overwrite the other. A negative figure is a valid way to correct a mistake.
  app.post('/admin/player/:tid/season-points', adminAuth, async (req, res) => {
    try {
      const raw = Number((req.body || {}).points);
      if (!Number.isFinite(raw) || Math.trunc(raw) === 0) {
        return res.status(400).json({ error: 'Укажи количество очков' });
      }
      const points = Math.trunc(raw);
      const note = String((req.body || {}).note || '').slice(0, 200);
      const p = await PlayerModel.findOne({ telegramId: req.params.tid }, 'telegramId username savedData.seasonPoints');
      if (!p) return res.status(404).json({ error: 'Not found' });
      // savedData may be null on an account that only ever pressed /start — a
      // dotted $inc through a null parent throws (see _incBalance).
      await PlayerModel.updateOne({ _id: p._id, savedData: null }, { $set: { savedData: {} } });
      const doc = await PlayerModel.findOneAndUpdate(
        { _id: p._id },
        { $inc: { 'savedData.seasonPoints': points } },
        { new: true, projection: { 'savedData.seasonPoints': 1 } },
      ).lean();
      if (!doc) return res.status(404).json({ error: 'Not found' });
      // Never below zero: a correction bigger than the balance would otherwise
      // leave a negative total sitting in the leaderboard.
      let total = Math.floor(Number(doc.savedData?.seasonPoints) || 0);
      if (total < 0) {
        await PlayerModel.updateOne({ _id: p._id }, { $set: { 'savedData.seasonPoints': 0 } });
        total = 0;
      }
      logPlayer(p.telegramId, p.username, 'admin_season_points', { add: points, total, note });
      // The player's live session holds its own copy of the total; tell it to
      // refetch rather than letting the panel show a number their game doesn't.
      io.to(`tg_${p.telegramId}`).emit('seasonRefresh', { total });
      res.json({ ok: true, total });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
