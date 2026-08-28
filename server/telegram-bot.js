'use strict';
// Telegram bot + admin GRAM-tx notifications, moved out of server/index.js
// verbatim. Exposed as a factory (createTelegramBot(deps)) so it can close
// over runtime state that still lives in index.js — io, the balance mover,
// and the bot-username cache (a `let` several routes elsewhere in index.js
// also read/write directly, so it crosses this boundary as a get/set pair
// rather than a plain value, same reasoning as admin.js's _maintenanceMode).
const PlayerModel = require('./models/Player');
const GramTxModel = require('./models/GramTx');
const { logPlayer } = require('./player-log');
const { _round2 } = require('./inventory');
const { _safeUsername, _tgEsc } = require('./security');
const { _GRAM_WITHDRAW_FEE_PCT } = require('./shop');

// Bot token — set TG_BOT_TOKEN env var in Railway
const _TG_TOKEN = process.env.TG_BOT_TOKEN || '';

module.exports = function createTelegramBot(deps) {
  const { io, TG_ADMIN_ID, _incBalance, safeTimeout, _getTgBotUsername, _setTgBotUsername } = deps;

  // ── Telegram helpers ──────────────────────────────────────────────────────────
  function tgApi(method, body) {
    return fetch(`https://api.telegram.org/bot${_TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => ({ ok: false }));
  }

  // Admin notification with approve/reject buttons
  async function notifyAdminGram(tx) {
    if (!TG_ADMIN_ID) return;
    const isDeposit = tx.type === 'deposit';
    const header = isDeposit ? '💰 <b>Заявка на пополнение</b>' : '📤 <b>Заявка на вывод</b>';
    const fee    = isDeposit ? 0 : _round2(tx.amount * _GRAM_WITHDRAW_FEE_PCT);
    const payout = isDeposit ? 0 : _round2(tx.amount - fee);
    const lines = [
      header,
      `👤 ${_tgEsc(tx.username)} (<code>${_tgEsc(tx.telegramId)}</code>)`,
      `💎 ${Number(tx.amount)} GRAM`,
      isDeposit
        ? `🏷 Мемо: <code>${_tgEsc(tx.memo)}</code>`
        : `📬 Адрес: <code>${_tgEsc(tx.address)}</code>`,
      ...(isDeposit ? [] : [`💸 К отправке: ${payout} GRAM (комиссия ${fee} GRAM)`]),
      `🆔 <code>${tx._id}</code>`,
    ];
    const res = await tgApi('sendMessage', {
      chat_id: TG_ADMIN_ID,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Подтвердить', callback_data: `gram_ok:${tx._id}` },
        { text: '❌ Отклонить',   callback_data: `gram_no:${tx._id}` },
      ]]},
    });
    if (res.ok) {
      tx.adminMsgId = res.result.message_id;
      await tx.save();
    }
  }

  // Telegram long-polling for callback_query (admin button clicks)
  let _tgOffset = 0;
  async function _pollTg() {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${_TG_TOKEN}/getUpdates?offset=${_tgOffset}&timeout=20&allowed_updates=${encodeURIComponent('["callback_query","message"]')}`
      );
      const data = await res.json();
      if (data.ok) {
        for (const upd of data.result) {
          _tgOffset = upd.update_id + 1;
          if (upd.callback_query) _handleAdminCallback(upd.callback_query).catch(() => {});
          if (upd.message) _handleBotMessage(upd.message).catch(() => {});
        }
      }
    } catch { /* ignore network errors */ }
    safeTimeout('tgPoll', _pollTg, 500);
  }

  async function _handleAdminCallback(cq) {
    // These buttons approve real payouts, so the sender is checked rather than
    // assumed. Today they only exist in the admin's own chat, but nothing else
    // in this function would notice if that stopped being true.
    if (!TG_ADMIN_ID || String(cq?.from?.id || '') !== String(TG_ADMIN_ID)) return;
    const [action, txId] = (cq.data || '').split(':');
    if (!txId || !['gram_ok', 'gram_no'].includes(action)) return;

    await tgApi('answerCallbackQuery', { callback_query_id: cq.id });

    const tx = await GramTxModel.findById(txId);
    if (!tx || tx.status !== 'pending') {
      await tgApi('sendMessage', { chat_id: cq.message.chat.id, text: '⚠️ Уже обработано' });
      return;
    }

    const confirmed = action === 'gram_ok';
    tx.status = confirmed ? 'confirmed' : 'rejected';
    // Set only when this decision actually moved the balance (a confirmed
    // deposit or a refunded withdrawal); left null otherwise so the log shows
    // the decision without implying a credit that never happened.
    let _logBal = null;

    if ((confirmed && tx.type === 'deposit') || (!confirmed && tx.type === 'withdraw')) {
      const doc = await PlayerModel.findOne({ telegramId: tx.telegramId });
      if (doc) {
        // A confirmed deposit, or a rejected withdrawal being refunded. Both are
        // a pure "+amount" against whatever the account holds when the write
        // lands — the admin may well be pressing this button while the player is
        // out farming, and neither side should be able to erase the other.
        const newBal = await _incBalance(tx.telegramId, 'gramBalance', tx.amount, 'gram_deposit');
        if (newBal !== null) {
          io.to(`tg_${tx.telegramId}`).emit('gramBalanceUpdate', { balance: newBal });
          _logBal = newBal;
        }

        // 5% referral bonus on confirmed deposit
        if (confirmed && tx.type === 'deposit' && doc.referredBy) {
          const bonus = Math.round(tx.amount * 0.05 * 100) / 100;
          if (bonus > 0) {
            const refDoc = await PlayerModel.findOne({ telegramId: doc.referredBy });
            const refNewBal = refDoc ? await _incBalance(doc.referredBy, 'gramBalance', bonus, 'referral') : null;
            if (refDoc && refNewBal !== null) {
              io.to(`tg_${doc.referredBy}`).emit('gramBalanceUpdate', { balance: refNewBal });
              io.to(`tg_${doc.referredBy}`).emit('refBonusReceived', {
                bonus,
                fromUsername: doc.username,
                newBalance: refNewBal,
              });
              logPlayer(doc.referredBy, refDoc.username, 'gram_ref_bonus',
                { bonus, from: doc.username, newBalance: refNewBal });
            }
          }
        }
      }
    }

    await tx.save();
    io.to(`tg_${tx.telegramId}`).emit('gramTxUpdate', { id: tx._id.toString(), status: tx.status });
    logPlayer(tx.telegramId, tx.username, 'gram_' + tx.type + '_' + tx.status, {
      amount: tx.amount,
      ...(_logBal === null ? {} : { newBalance: _logBal }),
      tx: tx._id.toString(),
    });

    const label = confirmed ? '✅ Подтверждено' : '❌ Отклонено';
    await tgApi('editMessageReplyMarkup', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'done' }]] },
    });
  }

  function _txData(tx) {
    return {
      id: tx._id.toString(),
      type: tx.type,
      amount: tx.amount,
      address: tx.address || '',
      memo: tx.memo || '',
      status: tx.status,
      createdAt: tx.createdAt,
    };
  }

  // Shared by the classic bot "/start ref_X" chat flow (_handleBotMessage) and
  // the Mini App "?startapp=ref_X" direct-launch flow (loginTelegramWebApp) —
  // registers telegramId as referred by refId the first time either path sees
  // it (whichever fires first wins; the other is a no-op since referredBy is
  // already set by then). Returns the referrer's username for notifications/
  // welcome text, or null if no (new) referral was registered.
  async function _registerReferral(telegramId, username, refId, playerDoc) {
    if (!refId || refId === telegramId || playerDoc.referredBy) return null;
    playerDoc.referredBy = refId;
    await playerDoc.save();
    const referrer = await PlayerModel.findOne({ telegramId: refId }, 'username telegramId').lean();
    io.to(`tg_${refId}`).emit('friendJoined', { username });
    await tgApi('sendMessage', {
      chat_id: refId,
      text: [
        '🎉 <b>Друг принял приглашение!</b>',
        `👤 @${_tgEsc(username)} только что зашёл в игру по вашей ссылке.`,
        '',
        '💡 Когда друг пополняет GRAM — вы получаете <b>5% бонус</b>.',
      ].join('\n'),
      parse_mode: 'HTML',
    }).catch(() => {});
    return referrer?.username || null;
  }

  // Fires at most once per account, ever. Claiming the adminNotified flag is
  // what enforces that, rather than each caller trying to work out whether it is
  // the first to see this player — they can't reliably tell. The bot's organic
  // "/start" only LOOKS a player up (it deliberately doesn't create the record,
  // so isNewAccount below still does its job on first launch), which meant
  // isNewPlayer stayed true there forever: every extra /start sent another
  // message, and the normal "/start, then tap Играть" flow sent one from the bot
  // and a second from auth once the account was actually created.
  //
  // The claim is a single-document update, so it also settles the two-tabs /
  // reconnect race between concurrent auths, and it survives restarts.
  // Consequence worth knowing: someone who only presses /start and never opens
  // the game has no account row yet and so isn't announced — the message now
  // arrives when they first actually launch the game.
  async function _notifyAdminNewPlayer(username, telegramId, referrerUsername) {
    if (!TG_ADMIN_ID) return;
    const claimed = await PlayerModel.findOneAndUpdate(
      { telegramId, adminNotified: { $ne: true } },
      { $set: { adminNotified: true } },
    ).catch(() => null);
    if (!claimed) return;
    const refLine = referrerUsername
      ? `\n👥 Пригласил: @${_tgEsc(referrerUsername)}`
      : '\n👥 Источник: органика';
    await tgApi('sendMessage', {
      chat_id: TG_ADMIN_ID,
      text: [
        '🆕 <b>Новый игрок</b>',
        `👤 @${_tgEsc(username)} (<code>${_tgEsc(telegramId)}</code>)${refLine}`,
      ].join('\n'),
      parse_mode: 'HTML',
    }).catch(() => {});
  }

  async function _handleBotMessage(msg) {
    const text = msg?.text || '';
    const fromId = String(msg?.from?.id || '');
    if (!text.startsWith('/start') || !fromId) return;

    const parts = text.trim().split(' ');
    const param = parts[1] || '';
    const firstName = msg.from.first_name || '';
    const username = _safeUsername(msg.from.username || firstName, fromId);

    let isNewPlayer = false;
    let referrerUsername = null;

    // /start ref_TELEGRAMID — register referral immediately on first bot interaction
    if (param.startsWith('ref_')) {
      let player = await PlayerModel.findOne({ telegramId: fromId });
      if (!player) {
        isNewPlayer = true;
        player = await PlayerModel.create({ telegramId: fromId, username });
      }
      referrerUsername = await _registerReferral(fromId, username, param.slice(4), player);
    } else {
      // Organic /start — check if new player
      const existing = await PlayerModel.findOne({ telegramId: fromId });
      if (!existing) isNewPlayer = true;
    }

    // Notify admin about new players
    if (isNewPlayer) {
      _notifyAdminNewPlayer(username, fromId, referrerUsername).catch(() => {});
    }

    // Send welcome message with game button
    const gameUrl = process.env.GAME_URL || '';
    const button = gameUrl
      ? { text: '🎮 Играть сейчас', web_app: { url: gameUrl } }
      : { text: '🎮 Открыть игру', url: `https://t.me/${_getTgBotUsername() || 'game'}` };
    const channelButton = { text: '📢 Канал', url: 'https://t.me/Libertymmo' };
    const chatButton    = { text: '💬 Чат', url: 'https://t.me/+PrFI0HWtRi02NGU0' };

    // Escaped even though this one goes back to the player themselves: an
    // unbalanced tag makes Telegram reject the whole send with a 400, so the
    // welcome message (and its Играть button) would silently never arrive.
    const greeting = firstName ? `👋 Привет, <b>${_tgEsc(firstName)}</b>!` : '👋 Добро пожаловать!';
    const refText  = referrerUsername
      ? `\n🎁 Вас пригласил @${_tgEsc(referrerUsername)} — играйте вместе и зарабатывайте бонусы!`
      : '';

    // Loading-screen preview — sent as its own message just ahead of the
    // welcome text, for both organic /start and a /start ref_ referral link
    // (both reach this same shared send path, so one call covers either).
    // sendPhoto needs a real public HTTPS URL to fetch the image from; without
    // GAME_URL there's nothing here that serves it publicly, so it's skipped
    // rather than sent broken.
    if (gameUrl) {
      await tgApi('sendPhoto', {
        chat_id: fromId,
        photo: `${gameUrl.replace(/\/$/, '')}/images/splash-liberty.jpg`,
      }).catch(() => {});
    }

    await tgApi('sendMessage', {
      chat_id: fromId,
      parse_mode: 'HTML',
      text: [
        greeting,
        '',
        '⚔️ <b>Liberty</b> — мобильная MMORPG прямо в Telegram.',
        '',
        '🗡 Исследуй подземелья и уничтожай врагов',
        '🏆 Соревнуйся в рейтинге игроков',
        '🛡 Вступай в кланы и ходи в рейды',
        '💎 Улучшай снаряжение и прокачивай персонажа',
        refText,
        '',
        '▶️ Нажми кнопку ниже, чтобы начать!',
      ].filter(l => l !== null).join('\n'),
      reply_markup: { inline_keyboard: [[button], [channelButton, chatButton]] },
    }).catch(() => {});
  }

  function _refLink(telegramId) {
    const bot = _getTgBotUsername() || process.env.TG_BOT_USERNAME || '';
    if (!bot) return '';
    // Classic bot deep link — opens the bot's own chat first (by design; see
    // _handleBotMessage), not the Mini App directly. Telegram always requires
    // a manual "Запустить бота" tap before the resulting /start ref_<id>
    // message is actually sent — that's a platform-level anti-spam rule for
    // ANY bot, not something any code here can skip. loginTelegramWebApp also
    // reads start_param if the game is ever opened via a startapp link
    // instead, so nothing breaks if that path is used somewhere too.
    return `https://t.me/${bot}?start=ref_${telegramId}`;
  }

  // Telegram gives us `username` (a @handle, restricted to [A-Za-z0-9_]) only
  // for accounts that actually set one; everyone else falls back to first_name,
  // which is arbitrary user-chosen text. That string is then stored, shown to
  // other players (rating, market, profiles), written into the binary gameState
  // packet and embedded in the admin's Telegram notifications — so it is
  // normalised once, at the only place it enters the system (_safeUsername,
  // server/security.js).

  // Without a token there is no bot to ask, so the call can only ever 404 —
  // skipping it keeps a tokenless run (local dev) off the network entirely.
  if (!_getTgBotUsername() && _TG_TOKEN) {
    fetch(`https://api.telegram.org/bot${_TG_TOKEN}/getMe`)
      .then(r => r.json())
      .then(d => { if (d.ok) { _setTgBotUsername(d.result.username); console.log('TG bot:', d.result.username); } })
      .catch(err => console.error('Could not fetch TG bot username:', err));
  }

  return {
    tgApi, notifyAdminGram, _pollTg, _handleAdminCallback, _txData,
    _registerReferral, _notifyAdminNewPlayer, _handleBotMessage, _refLink,
  };
};
