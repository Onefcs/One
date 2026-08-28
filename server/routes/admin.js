'use strict';
// Admin REST API (dashboard backend), moved out of server/index.js verbatim.
//
// Registered as a factory (registerAdminRoutes(app, deps)) so it can close
// over runtime state that still lives in server/index.js — io, the session
// maps, the maintenance flag, and the race10/guildwar/fear/coop managers.
// Every route body below is unchanged from its original index.js position;
// only where it lives moved. See index.js's own call site for what `deps`
// carries and why (some of it — _gw, _race10, _coop, _fear — are plain
// object/Map references that only need this file's call to happen after
// their own `const` declaration; _maintenanceMode and _race10BonusCount are
// primitives admin routes both read AND write, so those two cross the
// boundary as get/set function pairs instead of plain values).
const PlayerModel = require('../models/Player');
const ClanModel = require('../models/Clan');
const GramTxModel = require('../models/GramTx');
const MarketListingModel = require('../models/MarketListing');
const SpecialQuestModel = require('../models/SpecialQuest');
const PlayerLogModel = require('../models/PlayerLog');
const ChatMessageModel = require('../models/ChatMessage');
const {
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCE_MAX, ENHANCEABLE_SLOTS, isStackableItem,
  COOP_ATTEMPTS, COOP_MIN_LEVEL, COOP_STAGE_LEVELS,
  FEAR_ATTEMPTS, FEAR_MIN_LEVEL, FEAR_MAX_WAVE,
} = require('../../shared/definitions');
const { _catalogBase, _SANITIZE_MAX } = require('../anticheat');
const { _invAdd, _invHasRoomFor } = require('../inventory');
const {
  _adminToken, _verifyAdminToken, _safeEqual,
  _loginLockedUntil, _recordLoginFail, _clearLoginFails,
} = require('../security');
const {
  logPlayer, LOG_KEEP_PER_PLAYER, LOG_SEASON_EVENTS, LOG_KEEP_SEASON_PER_PLAYER,
} = require('../player-log');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

function adminAuth(req, res, next) {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  if (!_verifyAdminToken(tok)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

module.exports = function registerAdminRoutes(app, deps) {
  const {
    io, activeSessions, globalChatHistory, tgApi, tgBroadcastAll, _incBalance, _kickAllForMaintenance,
    _escapeRegex, _publicChatHistory, _socketForTelegramId,
    eventBossState, scheduleEventBoss,
    _gw, _gwOpenWindow, _gwCloseWindow, _gwPublicState,
    _race10, _race10OpenWindow, _race10CloseWindow, _race10PublicState, _race10BonusReset,
    _coop, _fear,
    _getMaintenanceMode, _setMaintenanceMode,
    _getRace10BonusCount, _incRace10BonusCount,
  } = deps;

  // ── Admin REST API ─────────────────────────────────────────────────────────────
  // Blanket per-IP ceiling over every /admin route. The login endpoint has its
  // own (much stricter) brute-force lock; this covers the rest, where several
  // endpoints run unindexed scans and aggregations — a leaked or brute-forced
  // token shouldn't also be a way to flatten the database. Registered before the
  // routes below so it actually sees them.
  const _ADMIN_RL_WINDOW_MS = 60000;
  const _ADMIN_RL_MAX = 240;
  const _adminHits = new Map(); // ip → { n, resetAt }
  app.use('/admin', (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const e = _adminHits.get(ip);
    if (!e || now > e.resetAt) {
      _adminHits.set(ip, { n: 1, resetAt: now + _ADMIN_RL_WINDOW_MS });
      if (_adminHits.size > 5000) {
        _adminHits.forEach((v, k) => { if (now > v.resetAt) _adminHits.delete(k); });
      }
      return next();
    }
    if (++e.n > _ADMIN_RL_MAX) return res.status(429).json({ error: 'Слишком много запросов' });
    next();
  });

  app.post('/admin/login', (req, res) => {
    if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin disabled' });
    const ip = req.ip || 'unknown';
    const lockedUntil = _loginLockedUntil(ip);
    if (lockedUntil) {
      const mins = Math.ceil((lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Слишком много попыток. Повторите через ${mins} мин.` });
    }
    const { username, password } = req.body || {};
    // Constant-time compare on both fields so login timing leaks neither.
    const ok = _safeEqual(username, ADMIN_USERNAME) & _safeEqual(password, ADMIN_PASSWORD);
    if (!ok) {
      _recordLoginFail(ip);
      return res.status(401).json({ error: 'Wrong credentials' });
    }
    _clearLoginFails(ip);
    const ts  = Date.now();
    const tok = Buffer.from(JSON.stringify({ ts, sig: _adminToken(ts) })).toString('base64url');
    res.json({ token: tok });
  });

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

  // Top referrers — ranked by earnings (5%-of-confirmed-deposits bonus, same
  // math as the player-facing 'getReferrals' handler above, just summed across
  // every referral instead of one player's own). Pulled unlimited here (no
  // $limit before the earnings are known) since ranking by count would not
  // give the same order as ranking by GRAM earned.
  app.get('/admin/top-referrals', adminAuth, async (req, res) => {
    try {
      const rows = await PlayerModel.aggregate([
        { $match: { referredBy: { $ne: null } } },
        { $group: { _id: '$referredBy', count: { $sum: 1 }, referredIds: { $push: '$telegramId' } } },
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

      const referrers2 = rows.map(r => ({
        telegramId: r._id,
        username: nameByTid[r._id] || r._id,
        count: r.count,
        bonusEarned: Math.round(r.referredIds.reduce((s, tid) => s + (depositSumByTid[tid] || 0), 0) * 0.05 * 100) / 100,
      })).sort((a, b) => b.bonusEarned - a.bonusEarned).slice(0, 50);

      res.json({ referrers: referrers2 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Top market traders — ranked by total GRAM volume (bought + sold) across
  // completed (status:'sold') listings. sellerUsername/buyerUsername are
  // denormalized onto the listing itself at sale time, so this needs no join
  // back to Player for display names.
  app.get('/admin/top-market', adminAuth, async (req, res) => {
    try {
      const [sellers, buyers] = await Promise.all([
        MarketListingModel.aggregate([
          { $match: { status: 'sold' } },
          { $group: { _id: '$sellerId', username: { $first: '$sellerUsername' }, sold: { $sum: '$price' }, soldCount: { $sum: 1 } } },
        ]),
        MarketListingModel.aggregate([
          { $match: { status: 'sold', buyerId: { $ne: null } } },
          { $group: { _id: '$buyerId', username: { $first: '$buyerUsername' }, bought: { $sum: '$price' }, boughtCount: { $sum: 1 } } },
        ]),
      ]);
      const byId = {};
      sellers.forEach(s => {
        byId[s._id] = { telegramId: s._id, username: s.username || s._id, sold: s.sold, soldCount: s.soldCount, bought: 0, boughtCount: 0 };
      });
      buyers.forEach(b => {
        const row = byId[b._id] || (byId[b._id] = { telegramId: b._id, username: b.username || b._id, sold: 0, soldCount: 0, bought: 0, boughtCount: 0 });
        row.bought = b.bought;
        row.boughtCount = b.boughtCount;
      });
      const traders = Object.values(byId)
        .sort((a, b) => (b.sold + b.bought) - (a.sold + a.bought))
        .slice(0, 50);
      res.json({ traders });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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
        // Season 2's own field — see shared/definitions.js's Сезон 2 section.
        seasonPoints: Math.max(0, Math.floor(Number(p.savedData?.seasonPoints2) || 0)),
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
      if (nexum) await _incBalance(p.telegramId, 'nexumBalance', nexum, 'admin');
      if (gram) {
        const newG = await _incBalance(p.telegramId, 'gramBalance', gram, 'admin');
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
      const p = await PlayerModel.findOne({ telegramId: req.params.tid }, 'telegramId username savedData.seasonPoints2');
      if (!p) return res.status(404).json({ error: 'Not found' });
      // savedData may be null on an account that only ever pressed /start — a
      // dotted $inc through a null parent throws (see _incBalance).
      await PlayerModel.updateOne({ _id: p._id, savedData: null }, { $set: { savedData: {} } });
      const doc = await PlayerModel.findOneAndUpdate(
        { _id: p._id },
        { $inc: { 'savedData.seasonPoints2': points } },
        { new: true, projection: { 'savedData.seasonPoints2': 1 } },
      ).lean();
      if (!doc) return res.status(404).json({ error: 'Not found' });
      // Never below zero: a correction bigger than the balance would otherwise
      // leave a negative total sitting in the leaderboard.
      let total = Math.floor(Number(doc.savedData?.seasonPoints2) || 0);
      if (total < 0) {
        await PlayerModel.updateOne({ _id: p._id }, { $set: { 'savedData.seasonPoints2': 0 } });
        total = 0;
      }
      logPlayer(p.telegramId, p.username, 'admin_season_points', { add: points, total, note });
      // The player's live session holds its own copy of the total; tell it to
      // refetch rather than letting the panel show a number their game doesn't.
      io.to(`tg_${p.telegramId}`).emit('seasonRefresh', { total });
      res.json({ ok: true, total });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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

  app.get('/admin/chat', adminAuth, (req, res) => {
    res.json({ messages: _publicChatHistory() });
  });

  app.delete('/admin/chat/:idx', adminAuth, async (req, res) => {
    const idx = Number(req.params.idx);
    if (idx >= 0 && idx < globalChatHistory.length) {
      const [removed] = globalChatHistory.splice(idx, 1);
      // Also drop the persisted row — otherwise a deleted message came back on
      // the next restart, now that the history is DB-backed.
      if (removed && removed._id) {
        await ChatMessageModel.deleteOne({ _id: removed._id }).catch(err => console.error('admin chat delete:', err));
      }
    }
    res.json({ ok: true });
  });

  app.post('/admin/broadcast', adminAuth, async (req, res) => {
    try {
      const { text, target = 'all' } = req.body || {};
      if (!text) return res.status(400).json({ error: 'text required' });
      if (target === 'online') {
        let sent = 0;
        io.sockets.sockets.forEach(s => {
          if (s.data?.telegramId) {
            tgApi('sendMessage', { chat_id: s.data.telegramId, text, parse_mode: 'HTML' }).catch(() => {});
            sent++;
          }
        });
        return res.json({ ok: true, sent });
      }
      const sent = await tgBroadcastAll(text);
      res.json({ ok: true, sent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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
  // admin wants to run it off-schedule.
  //
  // Also grants everyone a bonus daily attempt for today (_race10BonusReset/
  // _incRace10BonusCount, index.js's own _attemptCap) — an extra, unscheduled
  // window is worthless to anyone who already spent their one regular attempt
  // in the normal 20:30 slot (or an earlier admin open) unless it comes with a
  // fresh attempt to spend on it.
  app.post('/admin/race10/open', adminAuth, (req, res) => {
    if (_race10.phase === 'reg') return res.status(409).json({ error: 'Регистрация уже открыта' });
    if (_race10.live) return res.status(409).json({ error: 'Забег уже идёт' });
    _race10BonusReset();
    const bonusAttempts = _incRace10BonusCount();
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
  // close — these buttons only gate combat access.
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
  // _maintenanceMode check in loginTelegramWebApp/loginTelegram, index.js) —
  // everyone else already connected gets kicked immediately, same as a ban.
  app.get('/admin/maintenance', adminAuth, (req, res) => {
    res.json({ on: _getMaintenanceMode() });
  });

  app.post('/admin/maintenance/on', adminAuth, (req, res) => {
    if (_getMaintenanceMode()) return res.status(409).json({ error: 'Уже включено' });
    _setMaintenanceMode(true);
    _kickAllForMaintenance();
    res.json({ ok: true });
  });

  app.post('/admin/maintenance/off', adminAuth, (req, res) => {
    if (!_getMaintenanceMode()) return res.status(409).json({ error: 'Уже выключено' });
    _setMaintenanceMode(false);
    res.json({ ok: true });
  });

  app.get('/admin/market', adminAuth, async (req, res) => {
    try {
      const { page = 1, tab = 'active' } = req.query;
      const filter = tab === 'history' ? { status: { $in: ['sold', 'cancelled'] } } : { status: 'active' };
      const listings = await MarketListingModel.find(filter)
        .sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean();
      // Resolve referrers via sellerId (field name in model)
      const sellerIds = [...new Set(listings.map(l => l.sellerId).filter(Boolean))];
      const sellers = await PlayerModel.find({ telegramId: { $in: sellerIds } }, 'username telegramId referredBy').lean();
      const sellerMap = Object.fromEntries(sellers.map(s => [s.telegramId, s]));
      const refIds = [...new Set(sellers.map(s => s.referredBy).filter(Boolean))];
      const refs = await PlayerModel.find({ telegramId: { $in: refIds } }, 'username telegramId').lean();
      const refMap = Object.fromEntries(refs.map(r => [r.telegramId, r.username]));
      res.json({ listings: listings.map(l => ({
        _id: l._id, status: l.status,
        itemName: l.item?.name || l.item?.id || '?',
        itemRarity: l.item?.rarity || '',
        price: l.price,
        sellerUsername: l.sellerUsername || sellerMap[l.sellerId]?.username || l.sellerId,
        buyerUsername: l.buyerUsername || null,
        referrerUsername: sellerMap[l.sellerId]?.referredBy ? (refMap[sellerMap[l.sellerId].referredBy] || null) : null,
        createdAt: l.createdAt, soldAt: l.soldAt,
      })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Cancels one active listing and returns its item to the seller — same
  // mechanics as the player's own marketCancel (server/index.js), just
  // initiated by an admin and for a seller who is very likely offline. Checks
  // for room BEFORE flipping the listing's status, same "never destroy the
  // item" rule marketCancel follows, so a full inventory refuses the cancel
  // entirely rather than cancelling and losing the item.
  async function _adminCancelListing(listingId) {
    const pre = await MarketListingModel.findOne({ _id: listingId, status: 'active' }).lean();
    if (!pre) return { ok: false, error: 'Лот не найден или уже закрыт' };

    const liveSocket = io.sockets.sockets.get(activeSessions.get(String(pre.sellerId)) || '');
    const live = liveSocket && liveSocket.data && liveSocket.data._adminApplyItems;
    let sellerDoc = null, sellerInv, sellerEq;
    if (live) {
      const base = liveSocket.data._adminReadItems();
      sellerInv = base.inventory.slice();
      sellerEq = base.equipment;
    } else {
      sellerDoc = await PlayerModel.findOne({ telegramId: pre.sellerId });
      if (!sellerDoc) return { ok: false, error: 'Продавец не найден' };
      const saved = sellerDoc.savedData || {};
      sellerInv = Array.isArray(saved.inventory) ? saved.inventory.slice() : [];
    }
    // _invHasRoomFor, not "!stackable && full" — see its own comment: a
    // stackable with no existing stack still needs a slot, and letting it
    // through here cancelled the listing and then destroyed the item.
    if (!_invHasRoomFor(sellerInv, pre.item)) {
      return { ok: false, error: 'У продавца полон инвентарь' };
    }

    const listing = await MarketListingModel.findOneAndUpdate(
      { _id: listingId, status: 'active' },
      { status: 'cancelled', soldAt: new Date() },
      { new: false }, // pre-update doc, still carries the item
    );
    if (!listing) return { ok: false, error: 'Лот не найден или уже закрыт' };

    // A refused live apply (the seller has an item op in flight) is treated as
    // "not delivered", which takes the branch below that puts the LISTING back
    // — the item is never left nowhere.
    let delivered = _invAdd(sellerInv, listing.item);
    if (delivered) {
      if (live) delivered = await liveSocket.data._adminApplyItems(sellerInv, sellerEq);
      else await PlayerModel.updateOne({ _id: sellerDoc._id }, { $set: { 'savedData.inventory': sellerInv } });
    }
    if (!delivered) {
      // The room check above already refused this case, so we only get here if
      // the seller's inventory changed in between. Put the listing back rather
      // than leaving it cancelled with the item nowhere — same reasoning as the
      // player-facing marketCancel handler.
      await MarketListingModel.updateOne(
        { _id: listing._id, status: 'cancelled' }, { status: 'active', soldAt: null },
      ).catch(() => {});
      logPlayer(listing.sellerId, listing.sellerUsername, 'admin_market_cancel_noroom',
        { listingId: String(listing._id), item: listing.item && listing.item.id, listingRestored: true });
      return { ok: false, error: 'У продавца полон инвентарь — лот оставлен активным' };
    }
    io.to(`tg_${listing.sellerId}`).emit('marketCancelled', {
      listingId: String(listing._id), item: listing.item, delivered,
    });
    logPlayer(listing.sellerId, listing.sellerUsername, 'admin_market_cancel',
      { listingId: String(listing._id), item: listing.item && listing.item.id, delivered });
    return { ok: true, delivered };
  }

  app.post('/admin/market/:id/cancel', adminAuth, async (req, res) => {
    try {
      const result = await _adminCancelListing(req.params.id);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Cancels every currently active listing, one at a time — same per-listing
  // safety (room check, item return) as the single-cancel endpoint above, just
  // looped. Not a hot path (an admin action, run rarely), so sequential is
  // fine and keeps each listing's DB round trip isolated from the others.
  // Each iteration is caught on its own: one listing throwing (a malformed
  // item, a lookup failure) used to abort the whole res.json below with a bare
  // 500, silently leaving every listing after it in the list still active with
  // no visible reason why. Now a bad one is just one more "failed" entry and
  // the rest still get processed.
  app.post('/admin/market/cancel-all', adminAuth, async (req, res) => {
    try {
      const listings = await MarketListingModel.find({ status: 'active' }, '_id').lean();
      let delivered = 0, failed = 0;
      const errors = [];
      for (const l of listings) {
        try {
          const result = await _adminCancelListing(l._id);
          if (result.ok && result.delivered) delivered++;
          else { failed++; errors.push({ id: String(l._id), error: result.error || 'Инвентарь полон' }); }
        } catch (e) {
          failed++;
          errors.push({ id: String(l._id), error: e.message });
          console.error('admin_market_cancel_all item failed:', l._id, e);
        }
      }
      // Each successful cancellation already logged itself individually
      // (_adminCancelListing above) against its own seller — nothing aggregate
      // to add here beyond the failures, capped so a bad batch can't bloat the
      // response.
      res.json({ ok: true, total: listings.length, delivered, failed, errors: errors.slice(0, 20) });
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

  // ── Special Quests (public — game client) ─────────────────────────────────────
  app.get('/api/special-quests', async (req, res) => {
    try {
      const quests = await SpecialQuestModel.find({ active: true }).sort({ createdAt: -1 }).lean();
      res.json({ quests });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
