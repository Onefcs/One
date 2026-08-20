'use strict';
// Admin: the dashboard counters, the player search and the referral leaderboard.
// Read-only aggregations over the whole collection, which is why they sit behind
// the /admin rate limiter — several of them are unindexed scans.
const PlayerModel = require('../models/Player');
const GramTxModel = require('../models/GramTx');
const REQUIRED_DEPS = ['adminAuth', 'io', '_escapeRegex'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`stats: missing deps: ${missing.join(', ')}`);
  const { adminAuth, io, _escapeRegex } = deps;

  app.get('/admin/stats', adminAuth, async (req, res) => {
    try {
      const now = new Date();
      const dayAgo  = new Date(now - 86400000);
      const weekAgo = new Date(now - 7 * 86400000);
      const [total, newToday, newWeek, gramSum] = await Promise.all([
        PlayerModel.countDocuments(),
        PlayerModel.countDocuments({ createdAt: { $gte: dayAgo } }),
        PlayerModel.countDocuments({ createdAt: { $gte: weekAgo } }),
        GramTxModel.aggregate([{ $match: { type: 'deposit', status: 'confirmed' } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
      ]);
      const online = io.sockets.sockets.size;
      const [topBm, topLvl, topGold, topNexum] = await Promise.all([
        PlayerModel.find({}, 'username bm savedData').sort({ bm: -1 }).limit(5).lean(),
        PlayerModel.find({}, 'username savedData').sort({ 'savedData.lvl': -1 }).limit(5).lean(),
        PlayerModel.find({}, 'username savedData').sort({ 'savedData.gold': -1 }).limit(5).lean(),
        PlayerModel.find({}, 'username savedData').sort({ 'savedData.nexumBalance': -1 }).limit(5).lean(),
      ]);
      const banned = await PlayerModel.countDocuments({ banned: true });
      res.json({
        total, newToday, newWeek, online, banned,
        gramTotal: gramSum[0]?.s || 0,
        tops: {
          bm:    topBm.map(p    => ({ username: p.username, val: p.bm || 0 })),
          lvl:   topLvl.map(p   => ({ username: p.username, val: p.savedData?.lvl || 1 })),
          gold:  topGold.map(p  => ({ username: p.username, val: p.savedData?.gold || 0 })),
          nexum: topNexum.map(p => ({ username: p.username, val: p.savedData?.nexumBalance || 0 })),
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/players', adminAuth, async (req, res) => {
    try {
      const { q = '', page = 1, limit = 30 } = req.query;
      const filter = q ? { username: { $regex: _escapeRegex(q).slice(0, 64), $options: 'i' } } : {};
      const [players, count] = await Promise.all([
        PlayerModel.find(filter, 'username telegramId bm banned savedData referredBy createdAt')
          .sort({ bm: -1 }).skip((page - 1) * limit).limit(Number(limit)).lean(),
        PlayerModel.countDocuments(filter),
      ]);
      const onlineIds = new Set([...io.sockets.sockets.values()].map(s => s.data?.telegramId).filter(Boolean));
      res.json({
        players: players.map(p => ({
          id: p._id, telegramId: p.telegramId, username: p.username,
          bm: p.bm || 0, banned: p.banned || false,
          lvl: p.savedData?.lvl || 1, gold: p.savedData?.gold || 0,
          nexum: p.savedData?.nexumBalance || 0, gram: p.savedData?.gramBalance || 0,
          referredBy: p.referredBy, createdAt: p.createdAt,
          online: onlineIds.has(p.telegramId),
        })),
        total: count,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Top referrers — ranked by how many accounts list them in `referredBy`,
  // same 5%-of-confirmed-deposits bonus math as the player-facing 'getReferrals'
  // handler above, just summed across every referral instead of one player's own.
  app.get('/admin/top-referrals', adminAuth, async (req, res) => {
    try {
      const rows = await PlayerModel.aggregate([
        { $match: { referredBy: { $ne: null } } },
        { $group: { _id: '$referredBy', count: { $sum: 1 }, referredIds: { $push: '$telegramId' } } },
        { $sort: { count: -1 } },
        { $limit: 50 },
      ]);
      if (!rows.length) return res.json({ referrers: [] });

      const referrers = await PlayerModel.find({ telegramId: { $in: rows.map(r => r._id) } }, 'username telegramId').lean();
      const nameByTid = {};
      referrers.forEach(r => { nameByTid[r.telegramId] = r.username; });

      const deposits = await GramTxModel.find({
        telegramId: { $in: rows.flatMap(r => r.referredIds) }, type: 'deposit', status: 'confirmed',
      }, 'telegramId amount').lean();
      const depositSumByTid = {};
      deposits.forEach(d => { depositSumByTid[d.telegramId] = (depositSumByTid[d.telegramId] || 0) + d.amount; });

      res.json({
        referrers: rows.map(r => ({
          telegramId: r._id,
          username: nameByTid[r._id] || r._id,
          count: r.count,
          bonusEarned: Math.round(r.referredIds.reduce((s, tid) => s + (depositSumByTid[tid] || 0), 0) * 0.05 * 100) / 100,
        })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
