'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'moderation.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id    INTEGER NOT NULL,
    chat_id    INTEGER NOT NULL,
    username   TEXT,
    full_name  TEXT,
    warns      INTEGER DEFAULT 0,
    is_banned  INTEGER DEFAULT 0,
    ban_until  INTEGER,
    is_muted   INTEGER DEFAULT 0,
    mute_until INTEGER,
    PRIMARY KEY (user_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS punishments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    chat_id    INTEGER NOT NULL,
    type       TEXT NOT NULL,
    reason     TEXT,
    by_admin   TEXT,
    duration   INTEGER,
    expires_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS active_punishments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    chat_id    INTEGER NOT NULL,
    type       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    done       INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS spam_tracker (
    user_id       INTEGER NOT NULL,
    chat_id       INTEGER NOT NULL,
    count         INTEGER DEFAULT 0,
    window_start  INTEGER DEFAULT 0,
    last_spam_ms  INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS flood_tracker (
    user_id      INTEGER NOT NULL,
    chat_id      INTEGER NOT NULL,
    count        INTEGER DEFAULT 0,
    window_start INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS join_leave_tracker (
    user_id      INTEGER NOT NULL,
    chat_id      INTEGER NOT NULL,
    jcount       INTEGER DEFAULT 0,
    lcount       INTEGER DEFAULT 0,
    total        INTEGER DEFAULT 0,
    window_start INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS link_violations (
    user_id  INTEGER NOT NULL,
    chat_id  INTEGER NOT NULL,
    count    INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS allowed_links (
    msg_id  INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    PRIMARY KEY (msg_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS admin_violations (
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    warns   INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS conflict_tracker (
    chat_id      INTEGER NOT NULL,
    msg_count    INTEGER DEFAULT 0,
    participants TEXT    DEFAULT '[]',
    window_start INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id)
  );

  CREATE INDEX IF NOT EXISTS idx_pun_user ON punishments(user_id, chat_id);
  CREATE INDEX IF NOT EXISTS idx_active   ON active_punishments(expires_at, done);
`);

const now = () => Math.floor(Date.now() / 1000);
const MAX_WARNS = 5;

/* -------- UPSERT / GET -------- */
function upsertUser(uid, cid, username, fullName) {
  db.prepare(`
    INSERT INTO users(user_id,chat_id,username,full_name) VALUES(?,?,?,?)
    ON CONFLICT(user_id,chat_id) DO UPDATE SET
      username=COALESCE(excluded.username,username),
      full_name=COALESCE(excluded.full_name,full_name)
  `).run(uid, cid, username||null, fullName||null);
}
function getUser(uid, cid) {
  upsertUser(uid, cid, null, null);
  return db.prepare('SELECT * FROM users WHERE user_id=? AND chat_id=?').get(uid, cid);
}

/* -------- ВАРНЫ -------- */
function addWarn(uid, cid, reason, byAdmin) {
  const u = getUser(uid, cid);
  const w = (u.warns||0) + 1;
  db.prepare('UPDATE users SET warns=? WHERE user_id=? AND chat_id=?').run(w, uid, cid);
  db.prepare(`INSERT INTO punishments(user_id,chat_id,type,reason,by_admin) VALUES(?,?,'warn',?,?)`)
    .run(uid, cid, reason, byAdmin||'Автомод');
  return { warns: w, max: MAX_WARNS, banned: w >= MAX_WARNS };
}
function removeWarn(uid, cid) {
  const u = getUser(uid, cid);
  const w = Math.max(0,(u.warns||0)-1);
  db.prepare('UPDATE users SET warns=? WHERE user_id=? AND chat_id=?').run(w, uid, cid);
  db.prepare(`INSERT INTO punishments(user_id,chat_id,type,reason) VALUES(?,?,'unwarn','Снят вручную')`).run(uid,cid);
  return w;
}

/* -------- МУТ -------- */
function muteUser(uid, cid, sec, reason, byAdmin) {
  const until = now()+sec;
  db.prepare('UPDATE users SET is_muted=1,mute_until=? WHERE user_id=? AND chat_id=?').run(until,uid,cid);
  db.prepare(`INSERT INTO punishments(user_id,chat_id,type,reason,by_admin,duration,expires_at) VALUES(?,?,'mute',?,?,?,?)`)
    .run(uid,cid,reason,byAdmin||'Автомод',sec,until);
  db.prepare(`INSERT INTO active_punishments(user_id,chat_id,type,expires_at) VALUES(?,?,'mute',?)`).run(uid,cid,until);
  return until;
}
function unmuteUser(uid, cid) {
  db.prepare(`UPDATE users SET is_muted=0,mute_until=NULL WHERE user_id=? AND chat_id=?`).run(uid,cid);
  db.prepare(`DELETE FROM active_punishments WHERE user_id=? AND chat_id=? AND type='mute'`).run(uid,cid);
  db.prepare(`INSERT INTO punishments(user_id,chat_id,type,reason) VALUES(?,?,'unmute','Снят')`).run(uid,cid);
}

/* -------- БАН -------- */
function banUser(uid, cid, sec, reason, byAdmin) {
  const until = sec ? now()+sec : null;
  db.prepare('UPDATE users SET is_banned=1,ban_until=? WHERE user_id=? AND chat_id=?').run(until,uid,cid);
  db.prepare(`INSERT INTO punishments(user_id,chat_id,type,reason,by_admin,duration,expires_at) VALUES(?,?,'ban',?,?,?,?)`)
    .run(uid,cid,reason,byAdmin||'Автомод',sec||null,until);
  if (until) db.prepare(`INSERT INTO active_punishments(user_id,chat_id,type,expires_at) VALUES(?,?,'ban',?)`).run(uid,cid,until);
  return until;
}
function unbanUser(uid, cid) {
  db.prepare(`UPDATE users SET is_banned=0,ban_until=NULL WHERE user_id=? AND chat_id=?`).run(uid,cid);
  db.prepare(`DELETE FROM active_punishments WHERE user_id=? AND chat_id=? AND type='ban'`).run(uid,cid);
  db.prepare(`INSERT INTO punishments(user_id,chat_id,type,reason) VALUES(?,?,'unban','Снят')`).run(uid,cid);
}

/* -------- СПАМ-ТРЕКЕР -------- */
// ПАУЗА 2 СЕКУНДЫ = сброс счётчика спама (человек остановился и продолжил = новая серия)
const SPAM_PAUSE_MS = 2000; // 2 секунды паузы сбрасывают счётчик

function trackSpam(uid, cid) {
  const nowMs = Date.now();
  let r = db.prepare('SELECT * FROM spam_tracker WHERE user_id=? AND chat_id=?').get(uid, cid);

  if (!r) {
    db.prepare('INSERT INTO spam_tracker(user_id,chat_id,count,window_start,last_spam_ms) VALUES(?,?,1,?,?)')
      .run(uid, cid, Math.floor(nowMs/1000), nowMs);
    return 1;
  }

  // Если прошло больше 2 секунд с последнего спам-сообщения — начинаем новую серию
  const pauseMs = nowMs - (r.last_spam_ms || 0);
  if (pauseMs > SPAM_PAUSE_MS) {
    db.prepare('UPDATE spam_tracker SET count=1, window_start=?, last_spam_ms=? WHERE user_id=? AND chat_id=?')
      .run(Math.floor(nowMs/1000), nowMs, uid, cid);
    return 1;
  }

  // Продолжение текущей серии — увеличиваем счётчик
  const c = r.count + 1;
  db.prepare('UPDATE spam_tracker SET count=?, last_spam_ms=? WHERE user_id=? AND chat_id=?')
    .run(c, nowMs, uid, cid);
  return c;
}

function resetSpam(uid, cid) {
  db.prepare('UPDATE spam_tracker SET count=0, window_start=0, last_spam_ms=0 WHERE user_id=? AND chat_id=?')
    .run(uid, cid);
}

/* -------- ФЛУД-ТРЕКЕР -------- */
function trackFlood(uid, cid) {
  const n=now(), W=5, LIMIT=5;
  let r = db.prepare('SELECT * FROM flood_tracker WHERE user_id=? AND chat_id=?').get(uid,cid);
  if (!r) { db.prepare('INSERT INTO flood_tracker VALUES(?,?,1,?)').run(uid,cid,n); return {count:1,exceeded:false}; }
  if (n-r.window_start>W) { db.prepare('UPDATE flood_tracker SET count=1,window_start=? WHERE user_id=? AND chat_id=?').run(n,uid,cid); return {count:1,exceeded:false}; }
  const c=r.count+1;
  db.prepare('UPDATE flood_tracker SET count=? WHERE user_id=? AND chat_id=?').run(c,uid,cid);
  return {count:c, exceeded:c>=LIMIT};
}
function resetFlood(uid,cid) { db.prepare('UPDATE flood_tracker SET count=0,window_start=0 WHERE user_id=? AND chat_id=?').run(uid,cid); }

/* -------- ВХОД/ВЫХОД -------- */
function trackJoinLeave(uid, cid) {
  const n=now(), W=600, LIMIT=3;
  let r = db.prepare('SELECT * FROM join_leave_tracker WHERE user_id=? AND chat_id=?').get(uid,cid);
  if (!r) { db.prepare('INSERT INTO join_leave_tracker(user_id,chat_id,total,window_start) VALUES(?,?,1,?)').run(uid,cid,n); return {total:1,exceeded:false}; }
  if (n-r.window_start>W) { db.prepare('UPDATE join_leave_tracker SET total=1,window_start=? WHERE user_id=? AND chat_id=?').run(n,uid,cid); return {total:1,exceeded:false}; }
  const t=r.total+1;
  db.prepare('UPDATE join_leave_tracker SET total=? WHERE user_id=? AND chat_id=?').run(t,uid,cid);
  return {total:t, exceeded:t>=LIMIT};
}

/* -------- ССЫЛКИ -------- */
function trackLinkViolation(uid,cid) {
  let r = db.prepare('SELECT * FROM link_violations WHERE user_id=? AND chat_id=?').get(uid,cid);
  if (!r) { db.prepare('INSERT INTO link_violations VALUES(?,?,1)').run(uid,cid); return 1; }
  const c=r.count+1;
  db.prepare('UPDATE link_violations SET count=? WHERE user_id=? AND chat_id=?').run(c,uid,cid);
  return c;
}
function resetLinkViolations(uid,cid) { db.prepare('UPDATE link_violations SET count=0 WHERE user_id=? AND chat_id=?').run(uid,cid); }
function allowLink(msgId,cid) { db.prepare('INSERT OR REPLACE INTO allowed_links VALUES(?,?)').run(msgId,cid); }
function isLinkAllowed(msgId,cid) { return !!db.prepare('SELECT 1 FROM allowed_links WHERE msg_id=? AND chat_id=?').get(msgId,cid); }

/* -------- НАРУШЕНИЯ АДМИНИСТРАТОРОВ -------- */
function trackAdminViolation(uid,cid) {
  let r = db.prepare('SELECT * FROM admin_violations WHERE user_id=? AND chat_id=?').get(uid,cid);
  if (!r) { db.prepare('INSERT INTO admin_violations VALUES(?,?,1)').run(uid,cid); return 1; }
  const w=r.warns+1;
  db.prepare('UPDATE admin_violations SET warns=? WHERE user_id=? AND chat_id=?').run(w,uid,cid);
  return w;
}

/* -------- КОНФЛИКТ-ТРЕКЕР -------- */
function trackConflict(cid, uid) {
  const n=now(), W=60; // окно 60 секунд
  let r = db.prepare('SELECT * FROM conflict_tracker WHERE chat_id=?').get(cid);
  if (!r) {
    db.prepare('INSERT INTO conflict_tracker(chat_id,msg_count,participants,window_start) VALUES(?,1,?,?)').run(cid, JSON.stringify([uid]), n);
    return {count:1, participants:[uid]};
  }
  let parts = JSON.parse(r.participants||'[]');
  if (n-r.window_start>W) {
    parts=[uid]; db.prepare('UPDATE conflict_tracker SET msg_count=1,participants=?,window_start=? WHERE chat_id=?').run(JSON.stringify(parts),n,cid);
    return {count:1,participants:parts};
  }
  if (!parts.includes(uid)) parts.push(uid);
  const c=r.msg_count+1;
  db.prepare('UPDATE conflict_tracker SET msg_count=?,participants=? WHERE chat_id=?').run(c,JSON.stringify(parts),cid);
  return {count:c,participants:parts};
}
function resetConflict(cid) { db.prepare('UPDATE conflict_tracker SET msg_count=0,participants=\'[]\',window_start=0 WHERE chat_id=?').run(cid); }

/* -------- ИСТЁКШИЕ -------- */
function getExpired() { return db.prepare('SELECT * FROM active_punishments WHERE expires_at<=? AND done=0').all(now()); }
function markDone(id) { db.prepare('UPDATE active_punishments SET done=1 WHERE id=?').run(id); }

/* -------- СТАТИСТИКА -------- */
function getWarnedUsers(cid)  { return db.prepare('SELECT * FROM users WHERE chat_id=? AND warns>0 ORDER BY warns DESC').all(cid); }
function getBannedUsers(cid)  { return db.prepare('SELECT * FROM users WHERE chat_id=? AND is_banned=1').all(cid); }
function getMutedUsers(cid)   { return db.prepare('SELECT * FROM users WHERE chat_id=? AND is_muted=1').all(cid); }
function getUserHistory(uid,cid) { return db.prepare('SELECT * FROM punishments WHERE user_id=? AND chat_id=? ORDER BY created_at DESC LIMIT 30').all(uid,cid); }

module.exports = {
  upsertUser, getUser,
  addWarn, removeWarn,
  muteUser, unmuteUser,
  banUser, unbanUser,
  trackSpam, resetSpam,
  trackFlood, resetFlood,
  trackJoinLeave,
  trackLinkViolation, resetLinkViolations, allowLink, isLinkAllowed,
  trackAdminViolation,
  trackConflict, resetConflict,
  getExpired, markDone,
  getWarnedUsers, getBannedUsers, getMutedUsers, getUserHistory,
  MAX_WARNS
};
