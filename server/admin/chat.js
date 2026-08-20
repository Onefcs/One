'use strict';
// Admin: global chat moderation and the Telegram broadcast.
const ChatMessageModel = require('../models/ChatMessage');
const REQUIRED_DEPS = ['adminAuth', 'io', 'tgApi', 'tgBroadcastAll', '_publicChatHistory', 'globalChatHistory'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`chat: missing deps: ${missing.join(', ')}`);
  const { adminAuth, io, tgApi, tgBroadcastAll, _publicChatHistory, globalChatHistory } = deps;

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

};
