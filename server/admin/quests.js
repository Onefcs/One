'use strict';
// Special Quests, admin CRUD. The sanitizer below is the whole point of these
// four routes existing rather than passing req.body to the model: without it
// any document shape got through, including keys the game later reads as if
// the server had written them.
const SpecialQuestModel = require('../models/SpecialQuest');
const REQUIRED_DEPS = ['adminAuth'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`quests: missing deps: ${missing.join(', ')}`);
  const { adminAuth } = deps;

  // ── Special Quests (admin CRUD) ──────────────────────────────────────────────
  app.get('/admin/special-quests', adminAuth, async (req, res) => {
    try { res.json({ quests: await SpecialQuestModel.find({}).sort({ createdAt: -1 }).lean() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Only the fields the quest editor actually offers are taken from the body —
  // passing req.body straight to the model let any document shape through,
  // including keys the game later reads as if the server had written them.
  function _questFields(body) {
    const b = body || {};
    const out = {};
    if (b.title  != null) out.title  = String(b.title).slice(0, 120);
    if (b.desc   != null) out.desc   = String(b.desc).slice(0, 500);
    if (b.url    != null) out.url    = String(b.url).slice(0, 500);
    if (b.icon   != null) out.icon   = String(b.icon).slice(0, 8);
    if (b.type   != null) out.type   = ['link', 'subscribe', 'custom'].includes(b.type) ? b.type : 'link';
    if (b.active != null) out.active = !!b.active;
    if (b.reward) {
      const n = v => Math.max(0, Math.min(Number(v) || 0, 1e9));
      out.reward = { gold: n(b.reward.gold), xp: n(b.reward.xp), nexum: n(b.reward.nexum) };
    }
    return out;
  }
  app.post('/admin/special-quests', adminAuth, async (req, res) => {
    try {
      const f = _questFields(req.body);
      if (!f.title) return res.status(400).json({ error: 'title required' });
      res.json({ quest: await SpecialQuestModel.create(f) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/admin/special-quests/:id', adminAuth, async (req, res) => {
    try {
      const q = await SpecialQuestModel.findByIdAndUpdate(req.params.id, _questFields(req.body), { new: true });
      res.json({ quest: q });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/admin/special-quests/:id', adminAuth, async (req, res) => {
    try { await SpecialQuestModel.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
};
