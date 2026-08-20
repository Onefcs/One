'use strict';
// Admin: handing back a spent Страх or Сотрудничество attempt.
//
// The second controller-shaped group in this directory, after events.js: it
// needs handles on the two machines whose runs it is clearing, because giving
// an attempt back to someone still inside a run would let them hold two.
const PlayerModel = require('../models/Player');
const REQUIRED_DEPS = ['adminAuth', 'logPlayer', '_socketForTelegramId', '_coop', '_fear', 'COOP_ATTEMPTS', 'COOP_MIN_LEVEL', 'COOP_STAGE_LEVELS', 'FEAR_ATTEMPTS', 'FEAR_MIN_LEVEL', 'FEAR_MAX_WAVE'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`attempts: missing deps: ${missing.join(', ')}`);
  const { adminAuth, logPlayer, _socketForTelegramId, _coop, _fear, COOP_ATTEMPTS, COOP_MIN_LEVEL, COOP_STAGE_LEVELS, FEAR_ATTEMPTS, FEAR_MIN_LEVEL, FEAR_MAX_WAVE } = deps;

  app.post('/admin/player/:tid/reset-fear-attempts', adminAuth, async (req, res) => {
    try {
      const p = await PlayerModel.findOneAndUpdate(
        { telegramId: req.params.tid },
        { $unset: { 'savedData.fearAttempts': '' } },
        { new: true },
      );
      if (!p) return res.status(404).json({ error: 'Not found' });
      logPlayer(p.telegramId, p.username, 'admin_reset_fear_attempts', { by: 'admin' });
      // Live-refresh the Events panel for anyone with it open right now —
      // otherwise they'd see the old attemptsLeft until their next fearSync
      // (opening/reopening the panel).
      const target = _socketForTelegramId(req.params.tid);
      if (target) {
        target.emit('fearState', {
          maxAttempts: FEAR_ATTEMPTS, maxWave: FEAR_MAX_WAVE, minLevel: FEAR_MIN_LEVEL,
          attemptsLeft: FEAR_ATTEMPTS, inRun: _fear.has(target.id), wave: _fear.get(target.id)?.wave || 0,
        });
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Same trick as reset-fear-attempts just above, for Сотрудничество (Coop).
  app.post('/admin/player/:tid/reset-coop-attempts', adminAuth, async (req, res) => {
    try {
      const p = await PlayerModel.findOneAndUpdate(
        { telegramId: req.params.tid },
        { $unset: { 'savedData.coopAttempts': '' } },
        { new: true },
      );
      if (!p) return res.status(404).json({ error: 'Not found' });
      logPlayer(p.telegramId, p.username, 'admin_reset_coop_attempts', { by: 'admin' });
      const target = _socketForTelegramId(req.params.tid);
      if (target) {
        const run = _coop.get(target.id);
        target.emit('coopState', {
          maxAttempts: COOP_ATTEMPTS, maxStage: COOP_STAGE_LEVELS.length, minLevel: COOP_MIN_LEVEL,
          attemptsLeft: COOP_ATTEMPTS, inRun: !!run, stage: run?.room ? run.room.coopStage() : 0,
        });
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
