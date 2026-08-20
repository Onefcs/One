'use strict';
// Admin: manual control over the timed events — summon the world boss, force a
// Кровавая Башня or Война гильдий window open or shut, read their state.
//
// Thirteen dependencies, every one a handle on a machine in server/events/.
// That is not entanglement to be trimmed: a controller over six machines needs
// a handle on each machine it controls, and the list being long and explicit is
// what tells you exactly which ones this panel can reach.
const REQUIRED_DEPS = ['adminAuth', 'eventBossState', 'scheduleEventBoss', '_gw', '_gwPublicState', '_gwOpenWindow', '_gwCloseWindow', '_race10', '_race10PublicState', '_race10OpenWindow', '_race10CloseWindow', '_race10GrantBonusAttempt'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`events: missing deps: ${missing.join(', ')}`);
  const { adminAuth, eventBossState, scheduleEventBoss, _gw, _gwPublicState, _gwOpenWindow, _gwCloseWindow, _race10, _race10PublicState, _race10OpenWindow, _race10CloseWindow, _race10GrantBonusAttempt } = deps;

  // Summon the world-event boss (shared/definitions.js EVENT_BOSS) — it appears
  // on the map immediately.
  app.post('/admin/event-boss', adminAuth, (req, res) => {
    const r = scheduleEventBoss();
    if (r.error) return res.status(409).json({ error: r.error });
    res.json(r);
  });

  app.get('/admin/event-boss', adminAuth, (req, res) => {
    const st = eventBossState();
    res.json({ spawnAt: st.spawnAt, alive: st.alive, dropsOnGround: st.drops.length });
  });

  // Force-opens the Кровавая Башня registration window right now, same
  // RACE10_REG_MS window as the normal 20:30 MSK schedule — for whenever an
  // admin wants to run it off-schedule. _race10OpenWindow/_race10PublicState
  // are defined further down the file; safe to reference here since this
  // callback only runs once a request arrives, well after the whole module
  // (and the const _race10 it closes over) has finished loading — same
  // pattern the DEV_LOCAL-only /dev/race10/open route above already relies on.
  //
  // Also grants everyone a bonus daily attempt for today (_race10BonusReset/
  // _race10BonusCount, near _attemptCap above) — an extra, unscheduled window
  // is worthless to anyone who already spent their one regular attempt in the
  // normal 20:30 slot (or an earlier admin open) unless it comes with a fresh
  // attempt to spend on it.
  app.post('/admin/race10/open', adminAuth, (req, res) => {
    if (_race10.phase === 'reg') return res.status(409).json({ error: 'Регистрация уже открыта' });
    if (_race10.live) return res.status(409).json({ error: 'Забег уже идёт' });
    const bonusAttempts = _race10GrantBonusAttempt();
    _race10OpenWindow(Date.now());
    res.json({ ok: true, startAt: _race10.startAt, bonusAttempts });
  });

  // Cancels an open registration window early — same effect as the normal
  // close once the 5-minute registration period runs out (_race10CloseWindow):
  // bumps everyone still queued back to "not registered" and re-arms the
  // scheduler for the next regular 20:30 window. Does not touch an
  // already-running race (_race10.live) — there is nothing left in the queue
  // by the time a race starts anyway.
  app.post('/admin/race10/close', adminAuth, (req, res) => {
    if (_race10.phase !== 'reg') return res.status(409).json({ error: 'Регистрация не открыта' });
    _race10CloseWindow();
    res.json({ ok: true });
  });

  app.get('/admin/race10', adminAuth, (req, res) => {
    res.json(_race10PublicState());
  });

  // Guild War: force-opens the 22:00-22:15 MSK combat window right now. Unlike
  // race10's admin-open there's no per-player attempt counter to bump — the
  // zone has no capacity/attempt limit at all, so this behaves exactly like
  // the scheduled open (_gwOpenWindow always arms one GUILD_WAR_WINDOW_MS
  // closeTimer, admin-forced or not). Ownership/income are untouched by open/
  // close — these buttons only gate combat access. _gwOpenWindow/_gwCloseWindow
  // /_gwPublicState are defined further up the file; safe to reference here
  // since this callback only runs once a request arrives, same pattern
  // /admin/race10/open above already relies on.
  app.post('/admin/guildwar/open', adminAuth, (req, res) => {
    if (_gw.phase === 'live') return res.status(409).json({ error: 'Уже открыто' });
    clearTimeout(_gw.closeTimer);
    _gwOpenWindow();
    res.json({ ok: true });
  });

  app.post('/admin/guildwar/close', adminAuth, (req, res) => {
    if (_gw.phase !== 'live') return res.status(409).json({ error: 'Уже закрыто' });
    _gwCloseWindow();
    res.json({ ok: true });
  });

  app.get('/admin/guildwar', adminAuth, (req, res) => {
    res.json(_gwPublicState());
  });

  // Maintenance mode: while on, only TG_ADMIN_ID may log in (see the
  // _maintenanceMode check in loginTelegramWebApp/loginTelegram above) —
  // everyone else already connected gets kicked immediately, same as a ban.
};
