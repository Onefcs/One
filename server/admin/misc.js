'use strict';
// Read-only admin lists that answer one question each and share nothing:
// GRAM transactions, the clan roster and its delete, and the suspicious-account
// scan. Grouped by having no dependencies rather than by subject.
const ClanModel = require('../models/Clan');
const GramTxModel = require('../models/GramTx');
const PlayerModel = require('../models/Player');
const REQUIRED_DEPS = ['adminAuth'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`misc: missing deps: ${missing.join(', ')}`);
  const { adminAuth } = deps;

  app.get('/admin/transactions', adminAuth, async (req, res) => {
    try {
      const { status, page = 1 } = req.query;
      const filter = status ? { status } : {};
      const txs = await GramTxModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean();
      res.json({ txs });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/clans', adminAuth, async (req, res) => {
    try {
      const clans = await ClanModel.find({}, 'name icon level xp members').sort({ level: -1, xp: -1 }).lean();
      res.json({ clans: clans.map(c => ({
        id: c._id, name: c.name, icon: c.icon, level: c.level, xp: c.xp,
        memberCount: c.members?.length || 0,
        members: c.members?.map(m => ({ username: m.username, role: m.role, telegramId: m.telegramId })) || [],
      })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/admin/clan/:id', adminAuth, async (req, res) => {
    try {
      await ClanModel.deleteOne({ _id: req.params.id });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/admin/suspicious', adminAuth, async (req, res) => {
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      const players = await PlayerModel.find(
        { createdAt: { $gte: weekAgo }, bm: { $gt: 3000 } },
        'username telegramId bm savedData createdAt'
      ).sort({ bm: -1 }).limit(50).lean();
      res.json({ players: players.map(p => ({
        telegramId: p.telegramId, username: p.username,
        bm: p.bm, lvl: p.savedData?.lvl || 1,
        gold: p.savedData?.gold || 0, createdAt: p.createdAt,
        ageHours: Math.round((Date.now() - new Date(p.createdAt)) / 3600000),
      })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
