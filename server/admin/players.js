'use strict';
// Admin: one player's card, and banning or unbanning them. The card reads the
// event log, which is trimmed on two different budgets — ordinary rows on a
// short one, season-point movements on a much longer one, since those are what
// an appeal gets checked against.
const PlayerModel = require('../models/Player');
const PlayerLogModel = require('../models/PlayerLog');
const REQUIRED_DEPS = ['adminAuth', 'io', 'logPlayer', 'LOG_KEEP_PER_PLAYER', 'LOG_KEEP_SEASON_PER_PLAYER', 'LOG_SEASON_EVENTS'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`players: missing deps: ${missing.join(', ')}`);
  const { adminAuth, io, logPlayer, LOG_KEEP_PER_PLAYER, LOG_KEEP_SEASON_PER_PLAYER, LOG_SEASON_EVENTS } = deps;

  app.get('/admin/player/:tid', adminAuth, async (req, res) => {
    try {
      const p = await PlayerModel.findOne({ telegramId: req.params.tid }).lean();
      if (!p) return res.status(404).json({ error: 'Not found' });
      // Season rows come back as their own list. Folding them into `logs` would
      // hide them again the moment a player has 100 newer ordinary rows, which
      // after any real farming session is always.
      const [logs, seasonLogs, referrer] = await Promise.all([
        PlayerLogModel.find({ telegramId: req.params.tid }).sort({ at: -1 }).limit(LOG_KEEP_PER_PLAYER).lean(),
        PlayerLogModel.find({ telegramId: req.params.tid, event: { $in: LOG_SEASON_EVENTS } })
          .sort({ at: -1 }).limit(LOG_KEEP_SEASON_PER_PLAYER).lean(),
        p.referredBy ? PlayerModel.findOne({ telegramId: p.referredBy }, 'username').lean() : null,
      ]);
      res.json({
        player: p, logs, seasonLogs,
        seasonPoints: Math.max(0, Math.floor(Number(p.savedData?.seasonPoints) || 0)),
        referrerUsername: referrer?.username || null,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/admin/player/:tid/ban', adminAuth, async (req, res) => {
    try {
      const p = await PlayerModel.findOneAndUpdate({ telegramId: req.params.tid }, { banned: true }, { new: true });
      if (!p) return res.status(404).json({ error: 'Not found' });
      // Kick if online
      io.sockets.sockets.forEach(s => {
        if (s.data?.telegramId === req.params.tid) {
          s.emit('kicked', { reason: 'Вы заблокированы администратором' });
          s.disconnect(true);
        }
      });
      logPlayer(p.telegramId, p.username, 'ban', { by: 'admin', reason: req.body?.reason || '' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/admin/player/:tid/unban', adminAuth, async (req, res) => {
    try {
      const p = await PlayerModel.findOneAndUpdate({ telegramId: req.params.tid }, { banned: false }, { new: true });
      if (!p) return res.status(404).json({ error: 'Not found' });
      logPlayer(p.telegramId, p.username, 'unban', { by: 'admin' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Wipes today's Страх (Fear) attempt counter for one player, back to the
  // full daily cap — same "unset the tracked record" trick _lockDailyAttempt's
  // own shape relies on: _dailyAttemptsLeft treats a missing/stale record as
  // "nothing spent today" (see server/index.js's _dailyAttemptsLeft), so this
  // doesn't need to know the current count at all, just clear it.
};
