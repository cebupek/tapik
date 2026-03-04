'use strict';
const db = require('./database');
const { fmtDur, esc, mention } = require('./detectors');

const now = () => Math.floor(Date.now() / 1000);

const MUTE_OFF = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false,
  can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false,
  can_send_other_messages: false, can_add_web_page_previews: false,
};
const MUTE_ON = {
  can_send_messages: true, can_send_audios: true, can_send_documents: true,
  can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
  can_send_voice_notes: true, can_send_polls: true,
  can_send_other_messages: true, can_add_web_page_previews: true,
};

const applyMute   = async (bot, cid, uid, sec) => { try { await bot.restrictChatMember(cid, uid, { permissions: MUTE_OFF, until_date: now() + sec }); return true; } catch (e) { console.error('mute:', e.message); return false; } };
const applyUnmute = async (bot, cid, uid) =>      { try { await bot.restrictChatMember(cid, uid, { permissions: MUTE_ON }); return true; } catch (e) { console.error('unmute:', e.message); return false; } };
const applyBan    = async (bot, cid, uid, sec) => { try { await bot.banChatMember(cid, uid, { until_date: sec ? now() + sec : 0 }); return true; } catch (e) { console.error('ban:', e.message); return false; } };
const applyUnban  = async (bot, cid, uid) =>      { try { await bot.unbanChatMember(cid, uid, { only_if_banned: true }); return true; } catch (e) { console.error('unban:', e.message); return false; } };
const applyKick   = async (bot, cid, uid) =>      { try { await bot.banChatMember(cid, uid, { until_date: now() + 40 }); return true; } catch (e) { console.error('kick:', e.message); return false; } };

const del = async (bot, cid, mid) => { try { await bot.deleteMessage(cid, mid); } catch (_) {} };
const say = async (bot, cid, text) => {
  try { return await bot.sendMessage(cid, text, { parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch (e) { console.error('say:', e.message); }
};

const demote = async (bot, cid, uid) => {
  try {
    await bot.promoteChatMember(cid, uid, {
      is_anonymous: false, can_manage_chat: false, can_delete_messages: false,
      can_manage_video_chats: false, can_restrict_members: false,
      can_promote_members: false, can_change_info: false,
      can_invite_users: false, can_pin_messages: false,
    });
    return true;
  } catch (e) { console.error('demote:', e.message); return false; }
};

// ---- комплексные действия ----

async function doWarn(bot, cid, uid, username, fullName, reason, byAdmin) {
  db.upsertUser(uid, cid, username, fullName);
  const r = db.addWarn(uid, cid, reason, byAdmin || 'Автомод');
  const name = mention(uid, fullName || username || String(uid));
  if (r.banned) {
    db.banUser(uid, cid, null, `Лимит ${db.MAX_WARNS} варнов`, 'Автомод');
    await applyBan(bot, cid, uid, null);
    return { banned: true, text: `🚫 ${name} — <b>БАН НАВСЕГДА</b>\n📌 Причина: <i>${esc(reason)}</i>\n⚠️ Превышен лимит варнов (${r.warns}/${r.max})` };
  }
  const left = r.max - r.warns;
  return {
    banned: false,
    warns: r.warns,
    text: `⚠️ ${name} — <b>Варн ${r.warns}/${r.max}</b>\n📌 Причина: <i>${esc(reason)}</i>\n` +
          (left <= 1 ? `⛔ Следующее нарушение = <b>бан навсегда!</b>` : `Ещё ${left} нарушений до бана.`),
  };
}

async function doMute(bot, cid, uid, username, fullName, sec, reason, byAdmin) {
  db.upsertUser(uid, cid, username, fullName);
  db.muteUser(uid, cid, sec, reason, byAdmin || 'Автомод');
  await applyMute(bot, cid, uid, sec);
  return `🔇 ${mention(uid, fullName || username || String(uid))} — <b>мут на ${fmtDur(sec)}</b>\n📌 Причина: <i>${esc(reason)}</i>`;
}

async function doBan(bot, cid, uid, username, fullName, sec, reason, byAdmin) {
  db.upsertUser(uid, cid, username, fullName);
  db.banUser(uid, cid, sec, reason, byAdmin || 'Автомод');
  await applyBan(bot, cid, uid, sec);
  return `🚫 ${mention(uid, fullName || username || String(uid))} — <b>бан ${sec ? 'на ' + fmtDur(sec) : 'навсегда'}</b>\n📌 Причина: <i>${esc(reason)}</i>`;
}

async function doKick(bot, cid, uid, username, fullName, reason, byAdmin) {
  db.upsertUser(uid, cid, username, fullName);
  db.banUser(uid, cid, 40, reason, byAdmin || 'Автомод');
  await applyKick(bot, cid, uid);
  return `👢 ${mention(uid, fullName || username || String(uid))} — <b>кик</b>\n📌 Причина: <i>${esc(reason)}</i>`;
}

module.exports = { applyMute, applyUnmute, applyBan, applyUnban, applyKick, del, say, demote, doWarn, doMute, doBan, doKick };
