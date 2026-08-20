'use strict';
// Player event log + PvP history recording, moved out of server/index.js
// verbatim. Only depends on their own two models — no io, no session state.
const PlayerLogModel = require('./models/PlayerLog');
const PvpHistoryModel = require('./models/PvpHistory');

// ── Player event log ─────────────────────────────────────────────────────────
// Every economy-touching action lands here so a "where did my item go" report
// can be answered from the admin panel instead of guesswork. The old comment
// here claimed the collection was capped and TTL'd — neither was true, nothing
// ever deleted a row, so it grew without bound. It is now really trimmed.
const LOG_KEEP_PER_PLAYER = 100;
// Trimming on every write would double the cost of logging for no benefit —
// the admin only ever reads the newest LOG_KEEP_PER_PLAYER anyway, so a little
// overshoot between trims is harmless.
const LOG_TRIM_EVERY = 25;
const _logWritesSinceTrim = new Map(); // telegramId -> writes since last trim

// Season point movements are trimmed on their own, much longer, budget.
// Sharing the 100-row window with everything else made them effectively
// invisible: `inv:mob_loot` fires on most kills, so a quest award from a
// 5000-kill grind was pushed out of the log within minutes of earning it —
// which is exactly why "очки не начислились" reports could not be checked.
// These are the rows that decide who takes a prize, so they outlive the rest.
const LOG_SEASON_EVENTS = [
  'season_points', 'season_points_failed',
  'season_quest_done', 'season_quest_award_failed',
  'admin_season_points',
];
const LOG_KEEP_SEASON_PER_PLAYER = 1000;

async function logPlayer(telegramId, username, event, meta) {
  if (!telegramId) return;
  try {
    await PlayerLogModel.create({ telegramId, username, event, meta });
    const n = (_logWritesSinceTrim.get(telegramId) || 0) + 1;
    if (n < LOG_TRIM_EVERY) { _logWritesSinceTrim.set(telegramId, n); return; }
    _logWritesSinceTrim.set(telegramId, 0);
    // Two independent windows, so a flood of ordinary rows can never evict a
    // season one (and vice versa).
    const [stale, staleSeason] = await Promise.all([
      PlayerLogModel.find({ telegramId, event: { $nin: LOG_SEASON_EVENTS } }, '_id')
        .sort({ at: -1 }).skip(LOG_KEEP_PER_PLAYER).lean(),
      PlayerLogModel.find({ telegramId, event: { $in: LOG_SEASON_EVENTS } }, '_id')
        .sort({ at: -1 }).skip(LOG_KEEP_SEASON_PER_PLAYER).lean(),
    ]);
    const doomed = [...stale, ...staleSeason].map(d => d._id);
    if (doomed.length) await PlayerLogModel.deleteMany({ _id: { $in: doomed } });
  } catch {}
}

// Same log, for failures. Recorded under a single 'error' event so the panel
// can colour them and an admin can spot them without reading every row —
// these are exactly the entries that explain a lost item or a refused grant.
function logPlayerErr(telegramId, username, where, err, meta) {
  logPlayer(telegramId, username, 'error', {
    where,
    message: err && err.message ? err.message : String(err || ''),
    ...(meta || {}),
  });
}

// ── PvP history (profile → История tab) ──────────────────────────────────────
// Its own small collection, own trim — see server/models/PvpHistory.js for
// why this doesn't just piggyback on the log above.
const PVP_HISTORY_KEEP = 50;
const PVP_HISTORY_TRIM_EVERY = 10;
const _pvpHistoryWritesSinceTrim = new Map();
async function _recordPvpHistory(telegramId, kind, mode, opponent) {
  if (!telegramId) return;
  try {
    await PvpHistoryModel.create({ telegramId, kind, mode, opponent: opponent || null });
    const n = (_pvpHistoryWritesSinceTrim.get(telegramId) || 0) + 1;
    if (n < PVP_HISTORY_TRIM_EVERY) { _pvpHistoryWritesSinceTrim.set(telegramId, n); return; }
    _pvpHistoryWritesSinceTrim.set(telegramId, 0);
    const stale = await PvpHistoryModel.find({ telegramId }, '_id')
      .sort({ at: -1 }).skip(PVP_HISTORY_KEEP).lean();
    if (stale.length) await PvpHistoryModel.deleteMany({ _id: { $in: stale.map(d => d._id) } });
  } catch {}
}

module.exports = {
  logPlayer, logPlayerErr, _recordPvpHistory,
  LOG_KEEP_PER_PLAYER, LOG_SEASON_EVENTS, LOG_KEEP_SEASON_PER_PLAYER,
  PVP_HISTORY_KEEP,
  _logWritesSinceTrim, _pvpHistoryWritesSinceTrim,
};
