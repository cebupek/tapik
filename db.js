const Database = require('better-sqlite3');
const db = new Database('tapok.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS warns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mutes (
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    unmute_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS allowed_links (
    chat_id TEXT NOT NULL,
    link TEXT NOT NULL,
    PRIMARY KEY (chat_id, link)
  );

  CREATE TABLE IF NOT EXISTS mute_steps (
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    step INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
  );
`);

function addWarn(chatId, userId, reason) {
  const exp = Date.now() + 4 * 60 * 60 * 1000;
  db.prepare('INSERT INTO warns (chat_id,user_id,reason,expires_at) VALUES(?,?,?,?)')
    .run(String(chatId), String(userId), reason, exp);
}

function getWarns(chatId, userId) {
  return db.prepare('SELECT * FROM warns WHERE chat_id=? AND user_id=? AND expires_at>? ORDER BY expires_at ASC')
    .all(String(chatId), String(userId), Date.now());
}

function removeOneWarn(chatId, userId) {
  const w = db.prepare('SELECT id FROM warns WHERE chat_id=? AND user_id=? AND expires_at>? ORDER BY expires_at ASC LIMIT 1')
    .get(String(chatId), String(userId), Date.now());
  if (w) { db.prepare('DELETE FROM warns WHERE id=?').run(w.id); return true; }
  return false;
}

function clearExpired() {
  db.prepare('DELETE FROM warns WHERE expires_at<=?').run(Date.now());
}

function setMute(chatId, userId, ms) {
  db.prepare('INSERT OR REPLACE INTO mutes(chat_id,user_id,unmute_at) VALUES(?,?,?)')
    .run(String(chatId), String(userId), Date.now() + ms);
}

function getMute(chatId, userId) {
  return db.prepare('SELECT * FROM mutes WHERE chat_id=? AND user_id=?')
    .get(String(chatId), String(userId));
}

function delMute(chatId, userId) {
  db.prepare('DELETE FROM mutes WHERE chat_id=? AND user_id=?')
    .run(String(chatId), String(userId));
}

function getExpiredMutes() {
  return db.prepare('SELECT * FROM mutes WHERE unmute_at<=?').all(Date.now());
}

function allowLink(chatId, link) {
  db.prepare('INSERT OR IGNORE INTO allowed_links(chat_id,link) VALUES(?,?)')
    .run(String(chatId), link.toLowerCase().trim());
}

function isAllowed(chatId, link) {
  return !!db.prepare('SELECT 1 FROM allowed_links WHERE chat_id=? AND link=?')
    .get(String(chatId), link.toLowerCase().trim());
}

// Spam counter — каждый тип отдельно, возвращает новое значение

function getMuteStep(chatId, userId) {
  const r = db.prepare('SELECT step FROM mute_steps WHERE chat_id=? AND user_id=?')
    .get(String(chatId), String(userId));
  return r ? r.step : 0;
}

function incMuteStep(chatId, userId) {
  const next = getMuteStep(chatId, userId) + 1;
  db.prepare('INSERT OR REPLACE INTO mute_steps(chat_id,user_id,step) VALUES(?,?,?)')
    .run(String(chatId), String(userId), next);
  return next;
}

function clearWarns(chatId, userId) {
  db.prepare('DELETE FROM warns WHERE chat_id=? AND user_id=?')
    .run(String(chatId), String(userId));
}

module.exports = {
  addWarn, getWarns, removeOneWarn, clearExpired, clearWarns,
  setMute, getMute, delMute, getExpiredMutes,
  allowLink, isAllowed,
  getMuteStep, incMuteStep,
};