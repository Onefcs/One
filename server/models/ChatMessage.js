const mongoose = require('mongoose');

// Global chat, persisted so the last CHAT_HISTORY_MAX messages survive a
// server restart/redeploy. Everything else in the chat system (clan chat,
// DMs) is still in-memory only — this is the one channel every player sees
// on login, so it's the one where a restart wiping it is actually visible.
const ChatMessageSchema = new mongoose.Schema({
  username:  { type: String, default: '' },
  text:      { type: String, default: '' },
  // Pre-rendered "HH:MM" shown by the client. Stored rather than derived
  // from createdAt so a message reloaded after a restart still displays the
  // time it was actually sent, in the same format live messages use.
  time:      { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

// Startup load and the trim-to-last-N both sort by newest first.
ChatMessageSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
