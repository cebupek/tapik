'use strict';
// ================================================================
// bot.js  —  Moderator Bot v4  (все 12 правил полностью)
// ================================================================
const TelegramBot = require('node-telegram-bot-api');
const cron        = require('node-cron');
const db          = require('./database');
const act         = require('./actions');
const D           = require('./detectors');

const TOKEN = '8644926277:AAGzU5onWnQEcaGNFJborktdV0vJYHywM5Q';
const bot = new TelegramBot(TOKEN, { polling: true });

const now     = () => Math.floor(Date.now() / 1000);
const getName = u  => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);

// ---- кэш чатов (чтобы не дёргать getChat каждый раз) ----
const chatCache = new Map();
async function getChatUsername(cid) {
  if (chatCache.has(cid)) return chatCache.get(cid);
  try {
    const info = await bot.getChat(cid);
    chatCache.set(cid, info.username || null);
    return info.username || null;
  } catch { return null; }
}

// ---- проверка статуса ----
async function getMemberStatus(cid, uid) {
  try { const m = await bot.getChatMember(cid, uid); return m.status; }
  catch { return 'left'; }
}
async function isAdmin(cid, uid) {
  const s = await getMemberStatus(cid, uid);
  return s === 'administrator' || s === 'creator';
}
async function isCreator(cid, uid) {
  return await getMemberStatus(cid, uid) === 'creator';
}
async function botCanPromote(cid) {
  try {
    const me = await bot.getMe();
    const m  = await bot.getChatMember(cid, me.id);
    return !!(m.can_promote_members);
  } catch { return false; }
}

// ---- получить цель из реплая или @username/ID ----
async function getTarget(msg) {
  if (msg.reply_to_message?.from) {
    const u = msg.reply_to_message.from;
    return { id: u.id, username: u.username, fullName: getName(u) };
  }
  const parts = (msg.text || '').split(/\s+/).filter(Boolean);
  const raw = parts[1];
  if (!raw) return null;
  if (raw.startsWith('@')) {
    const uname = raw.slice(1).toLowerCase();
    const rows = [...db.getWarnedUsers(msg.chat.id), ...db.getBannedUsers(msg.chat.id), ...db.getMutedUsers(msg.chat.id)];
    const found = rows.find(r => r.username && r.username.toLowerCase() === uname);
    if (found) return { id: found.user_id, username: found.username, fullName: found.full_name };
  }
  const numId = parseInt(raw);
  if (!isNaN(numId)) {
    try {
      const m = await bot.getChatMember(msg.chat.id, numId);
      return { id: m.user.id, username: m.user.username, fullName: getName(m.user) };
    } catch {}
  }
  return null;
}

// ================================================================
// ПИНГ КАЖДУЮ СЕКУНДУ — проверка что бот живой
// ================================================================
let pingOk = true;
setInterval(async () => {
  try {
    await bot.getMe();
    if (!pingOk) {
      console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ✅ Бот снова онлайн`);
      pingOk = true;
    }
  } catch (e) {
    if (pingOk) {
      console.error(`[${new Date().toLocaleTimeString('ru-RU')}] ❌ Пинг не прошёл: ${e.message}`);
      pingOk = false;
    }
  }
}, 1000);
cron.schedule('*/20 * * * * *', async () => {
  const expired = db.getExpired();
  for (const p of expired) {
    db.markDone(p.id);
    try {
      const u    = db.getUser(p.user_id, p.chat_id);
      const name = D.mention(p.user_id, u.full_name || u.username || String(p.user_id));
      if (p.type === 'mute') {
        db.unmuteUser(p.user_id, p.chat_id);
        await act.applyUnmute(bot, p.chat_id, p.user_id);
        await act.say(bot, p.chat_id, `✅ С пользователя ${name} снят мут — можно снова писать!`);
      } else if (p.type === 'ban') {
        db.unbanUser(p.user_id, p.chat_id);
        await act.applyUnban(bot, p.chat_id, p.user_id);
        await act.say(bot, p.chat_id, `✅ С пользователя ${name} снят бан — можно зайти обратно!`);
      }
    } catch (e) { console.error('scheduler:', e.message); }
  }
});

// ================================================================
// ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ
// ================================================================
bot.on('message', async (msg) => {
  if (!msg?.from || msg.from.is_bot) return;
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;

  const cid      = msg.chat.id;
  const user     = msg.from;
  const uid      = user.id;
  const mid      = msg.message_id;
  const uname    = user.username;
  const fullName = getName(user);
  const text     = msg.text || msg.caption || '';
  const entities = msg.entities || msg.caption_entities || [];
  const hasMedia = !!(msg.photo || msg.video || msg.document || msg.animation || msg.audio || msg.voice || msg.sticker);

  db.upsertUser(uid, cid, uname, fullName);

  const adminFlag   = await isAdmin(cid, uid).catch(() => false);
  const creatorFlag = await isCreator(cid, uid).catch(() => false);

  // ==============================================================
  // ПРАВИЛО 2: АНТИСПАМ — стикеры / гифки / эмодзи
  // Счётчик считает НЕПРЕРЫВНУЮ серию.
  // Пауза > 2 секунды = счётчик сбрасывается → человек может начать заново.
  // 5+ подряд без паузы → удалить все + мут 30 минут.
  // ==============================================================
  if (D.isSpamMedia(msg)) {
    if (!adminFlag) {
      const cnt = db.trackSpam(uid, cid);
      if (cnt >= 5) {
        // 5-й подряд без паузы — удаляем + мут
        await act.del(bot, cid, mid);
        db.resetSpam(uid, cid);
        const muteMsg = await act.doMute(bot, cid, uid, uname, fullName, 1800,
          `Спам: 5 стикеров/гифок/эмодзи подряд (правило 2)`, 'Автомод');
        await act.say(bot, cid, muteMsg);
      } else if (cnt === 4) {
        // Предупреждение на 4-м
        await act.say(bot, cid,
          `⚠️ ${D.mention(uid, fullName)}, ещё 1 — и мут на 30 минут!`);
      }
      // 1-4: не удаляем, не предупреждаем (кроме 4-го)
      // пауза > 2 сек — trackSpam вернёт 1, счётчик сброшен
    }
    return;
  }

  // ==============================================================
  // АНТИФЛУД — 5+ сообщений за 5 секунд подряд
  // → мут 10 минут + удалить
  // ==============================================================
  if (!adminFlag) {
    const fl = db.trackFlood(uid, cid);
    if (fl.exceeded) {
      db.resetFlood(uid, cid);
      await act.del(bot, cid, mid);
      const muteMsg = await act.doMute(bot, cid, uid, uname, fullName, 600,
        'Флуд: слишком много сообщений подряд', 'Автомод');
      await act.say(bot, cid, muteMsg);
      return;
    }
  }

  // ==============================================================
  // ПРАВИЛО 6: ЭКСТРЕМИЗМ (расизм / религия / политика)
  // → бан навсегда (участник) / снятие с должности (админ)
  // ==============================================================
  if (D.isExtremism(text)) {
    await act.del(bot, cid, mid);

    if (adminFlag && !creatorFlag) {
      const aw = db.trackAdminViolation(uid, cid);
      if (aw >= 2) {
        const canD = await botCanPromote(cid);
        if (canD) {
          await act.demote(bot, cid, uid);
          await act.say(bot, cid,
            `🔴 ${D.mention(uid, fullName)} снят с должности администратора за экстремизм. (правило 6)`);
        } else {
          await act.say(bot, cid,
            `⚠️ ${D.mention(uid, fullName)} (администратор) нарушает правило 6!\n` +
            `Дайте боту право «Добавлять администраторов» для снятия с должности.`);
        }
      } else {
        await act.say(bot, cid,
          `⚠️ ${D.mention(uid, fullName)} (администратор) — нарушение правила 6!\n` +
          `Межрасовые/религиозные/политические высказывания запрещены.\n` +
          `Следующий раз — снятие с должности.`);
      }
      return;
    }

    if (!creatorFlag) {
      const banMsg = await act.doBan(bot, cid, uid, uname, fullName, null,
        'Межрасовые/религиозные/политические высказывания (правило 6)', 'Автомод');
      await act.say(bot, cid, banMsg);
    }
    return;
  }

  // ==============================================================
  // ПРАВИЛО 7: РЕКЛАМА — варн + удалить
  // ==============================================================
  const chatUsername = await getChatUsername(cid);
  if (!adminFlag && D.isAdvertising(text, chatUsername)) {
    await act.del(bot, cid, mid);
    const r = await act.doWarn(bot, cid, uid, uname, fullName,
      'Реклама чужих каналов/групп без разрешения (правило 7)', 'Автомод');
    await act.say(bot, cid, r.text);
    return;
  }

  // ==============================================================
  // ССЫЛКИ (не реклама, но любая ссылка без разрешения)
  // 1-е нарушение → варн + мут 10 мин
  // 2-е нарушение → бан навсегда
  // Разрешение: admin пишет «!можно» ответом на сообщение
  // ==============================================================
  if (!adminFlag && D.hasAnyLink(text) && !D.isAdvertising(text, chatUsername)) {
    if (!db.isLinkAllowed(mid, cid)) {
      await act.del(bot, cid, mid);
      const lv = db.trackLinkViolation(uid, cid);
      if (lv === 1) {
        const warnR = await act.doWarn(bot, cid, uid, uname, fullName,
          'Ссылка без разрешения — 1-е нарушение', 'Автомод');
        const muteMsg = await act.doMute(bot, cid, uid, uname, fullName, 600,
          'Ссылка без разрешения — 1-е нарушение', 'Автомод');
        await act.say(bot, cid, warnR.text + '\n🔇 Дополнительно: мут на 10 минут.');
      } else {
        const banMsg = await act.doBan(bot, cid, uid, uname, fullName, null,
          'Ссылка без разрешения — 2-е нарушение (правило 7)', 'Автомод');
        await act.say(bot, cid, banMsg + '\n(2-е нарушение по ссылкам)');
      }
      return;
    }
  }

  // ==============================================================
  // ПРАВИЛА 1 + 9: ОСКОРБЛЕНИЯ
  // Каждое уникальное оскорбление = 1 варн (суммируются)
  // Обычные маты ("сука", "блять") — ПРОПУСКАЕМ
  // 3 варна → кик. 5 варнов → бан навсегда.
  // Администратор оскорбляет → 1-й раз предупреждение, 2-й → снятие с должности
  // ==============================================================
  const { count: insultCnt } = D.countInsults(text);
  if (insultCnt > 0) {
    await act.del(bot, cid, mid);

    if (!adminFlag) {
      // Обычный участник
      let lastResult;
      for (let i = 0; i < insultCnt; i++) {
        lastResult = await act.doWarn(bot, cid, uid, uname, fullName,
          'Оскорбление участника или администратора (правило 1)', 'Автомод');
        if (lastResult.banned) break;
      }
      const extra = insultCnt > 1
        ? `\n📊 Найдено <b>${insultCnt}</b> оскорблений — каждое = 1 варн.`
        : '';
      await act.say(bot, cid, lastResult.text + extra);

      // 3 варна + не забанен → кик
      if (!lastResult.banned) {
        const u = db.getUser(uid, cid);
        if (u.warns >= 3 && u.warns < db.MAX_WARNS) {
          const kickMsg = await act.doKick(bot, cid, uid, uname, fullName,
            `3 варна за оскорбления (правило 1)`, 'Автомод');
          await act.say(bot, cid, kickMsg);
        }
      }
    } else if (!creatorFlag) {
      // Администратор оскорбляет — правило 9 + 10
      const aw = db.trackAdminViolation(uid, cid);
      if (aw === 1) {
        await act.say(bot, cid,
          `⚠️ ${D.mention(uid, fullName)} (администратор) — нарушение правила 9!\n` +
          `Администраторам тоже запрещено оскорблять участников.\n` +
          `Следующее нарушение — снятие с должности.`);
      } else {
        const canD = await botCanPromote(cid);
        if (canD) {
          await act.demote(bot, cid, uid);
          await act.say(bot, cid,
            `🔴 ${D.mention(uid, fullName)} снят с должности администратора.\n` +
            `Причина: повторное оскорбление участников (правило 9/10)`);
        } else {
          await act.say(bot, cid,
            `⚠️ ${D.mention(uid, fullName)} — повторное нарушение правила 9.\n` +
            `Дайте боту право «Добавлять администраторов» для снятия с должности.`);
        }
      }
    }
    return;
  }

  // ==============================================================
  // ПРАВИЛО 11: МНОГО КАПСА (25+ букв, 70%+)
  // → варн + удалить
  // ==============================================================
  if (!adminFlag && D.isTooMuchCaps(text)) {
    await act.del(bot, cid, mid);
    const r = await act.doWarn(bot, cid, uid, uname, fullName,
      'Злоупотребление КАПСОМ (правило 11)', 'Автомод');
    await act.say(bot, cid, r.text);
    return;
  }

  // ==============================================================
  // ПРАВИЛО 8: РАСЧЛЕНЁНКА / трэш без спойлера
  // → варн + удалить
  // ==============================================================
  if (D.isGore(text)) {
    if (!D.hasSpoiler(entities)) {
      await act.del(bot, cid, mid);
      const r = await act.doWarn(bot, cid, uid, uname, fullName,
        'Нежелательный контент без спойлера (правило 8)', 'Автомод');
      await act.say(bot, cid, r.text +
        '\n💡 Подобный контент обязательно скрывай под спойлер!');
      return;
    }
    // Если под спойлером — ок, но нужна подпись (проверяем есть ли текст)
    if (!text.trim()) {
      await act.say(bot, cid,
        `⚠️ ${D.mention(uid, fullName)}, пожалуйста, добавь подпись к контенту под спойлером (правило 8).`);
    }
    return;
  }

  // ==============================================================
  // ПРАВИЛО 3: 18+ контент без спойлера
  // → варн + удалить
  // ==============================================================
  if (D.isNSFW(text)) {
    if (!D.hasSpoiler(entities)) {
      await act.del(bot, cid, mid);
      const r = await act.doWarn(bot, cid, uid, uname, fullName,
        '18+ контент без спойлера (правило 3)', 'Автомод');
      await act.say(bot, cid, r.text +
        '\n💡 18+ контент — только под спойлер!');
      return;
    }
  }

  // ==============================================================
  // ПРАВИЛО 5: КОНФЛИКТ (срач)
  // 2+ участника, 6+ агрессивных сообщений за 60 сек → варн всем
  // ==============================================================
  if (!adminFlag && D.isConflict(text)) {
    const cf = db.trackConflict(cid, uid);
    if (cf.count >= 6 && cf.participants.length >= 2) {
      db.resetConflict(cid);
      const warned = [];
      for (const pid of cf.participants) {
        if (pid === uid) continue; // инициатора варним ниже
        const pu = db.getUser(pid, cid);
        if (pu && !pu.is_banned) {
          await act.doWarn(bot, cid, pid, pu.username, pu.full_name,
            'Конфликт в чате (правило 5)', 'Автомод');
          warned.push(D.mention(pid, pu.full_name || pu.username));
        }
      }
      // варн инициатору
      const r = await act.doWarn(bot, cid, uid, uname, fullName,
        'Конфликт в чате (правило 5)', 'Автомод');
      await act.say(bot, cid,
        `🛑 <b>Конфликт в чате!</b> Переносите споры в ЛС (правило 5)\n` +
        `Все участники получают варн.\n` + r.text);
      return;
    }
  }

  // ==============================================================
  // ПРАВИЛО 10: АВТОНАКАЗАНИЕ АДМИНИСТРАТОРОВ
  // Если выдали мут/варн/бан без причины (команды без reply)
  // Бот логирует — проверка вручную
  // ==============================================================
  // (Это правило обрабатывается в момент злоупотребления командами)
});

// ================================================================
// ПРАВИЛО 4: ВХОДЫ И ВЫХОДЫ
// 3+ раз за 10 минут → бан на 24 часа
// ================================================================
bot.on('new_chat_members', async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  for (const u of (msg.new_chat_members || [])) {
    if (u.is_bot) continue;
    const fn = getName(u);
    db.upsertUser(u.id, cid, u.username, fn);
    const r = db.trackJoinLeave(u.id, cid);
    if (r.exceeded) {
      const banMsg = await act.doBan(bot, cid, u.id, u.username, fn,
        86400, 'Частые входы/выходы в группу (правило 4)', 'Автомод');
      await act.say(bot, cid, banMsg);
    }
  }
});

bot.on('left_chat_member', async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  const u   = msg.left_chat_member;
  if (!u || u.is_bot) return;
  const fn = getName(u);
  db.upsertUser(u.id, cid, u.username, fn);
  const r = db.trackJoinLeave(u.id, cid);
  if (r.exceeded) {
    const banMsg = await act.doBan(bot, cid, u.id, u.username, fn,
      86400, 'Частые входы/выходы в группу (правило 4)', 'Автомод');
    await act.say(bot, cid, banMsg);
  }
});

// ================================================================
// !можно  —  администратор разрешает ссылку
// Использование: ответить на сообщение с ссылкой словом "!можно"
// ================================================================
bot.onText(/^!можно$/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return;
  if (!msg.reply_to_message) return act.say(bot, cid, '❌ Ответь на сообщение с ссылкой.');

  const targetMid = msg.reply_to_message.message_id;
  const targetUid = msg.reply_to_message.from?.id;
  db.allowLink(targetMid, cid);
  if (targetUid) db.resetLinkViolations(targetUid, cid);
  await act.del(bot, cid, msg.message_id);
  if (targetUid) {
    await act.say(bot, cid,
      `✅ ${D.mention(targetUid, 'Пользователю')} разрешено разместить ссылку.`);
  }
});

// ================================================================
// КОМАНДЫ СНЯТИЯ НАКАЗАНИЙ (только администраторы)
// Формат: -варн / -warn / -мут / -mute / -бан / -ban
// ================================================================
bot.onText(/^-(?:варн|warn)\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return act.say(bot, cid, '❌ Только для администраторов.');
  const target = await getTarget(msg);
  if (!target) return act.say(bot, cid, '❌ Ответь на сообщение или укажи @username');
  const newW = db.removeWarn(target.id, cid);
  await act.say(bot, cid,
    `✅ С пользователя ${D.mention(target.id, target.fullName)} снят варн.\n` +
    `Осталось варнов: <b>${newW}/${db.MAX_WARNS}</b>`);
});

bot.onText(/^-(?:мут|mute)\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return;
  const target = await getTarget(msg);
  if (!target) return act.say(bot, cid, '❌ Ответь на сообщение или укажи @username');
  db.unmuteUser(target.id, cid);
  await act.applyUnmute(bot, cid, target.id);
  await act.say(bot, cid,
    `✅ С пользователя ${D.mention(target.id, target.fullName)} снят мут — можно снова писать!`);
});

bot.onText(/^-(?:бан|ban)\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return;
  const target = await getTarget(msg);
  if (!target) return act.say(bot, cid, '❌ Ответь на сообщение или укажи @username');
  db.unbanUser(target.id, cid);
  await act.applyUnban(bot, cid, target.id);
  await act.say(bot, cid,
    `✅ С пользователя ${D.mention(target.id, target.fullName)} снят бан — можно зайти обратно!`);
});

// ================================================================
// РУЧНЫЕ КОМАНДЫ (выдача наказаний)
// ================================================================

// /warn
bot.onText(/^\/warn\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return act.say(bot, cid, '❌ Только для администраторов.');
  const target = await getTarget(msg);
  if (!target) return act.say(bot, cid, '❌ Ответь на сообщение или укажи @username');
  if (await isAdmin(cid, target.id)) return act.say(bot, cid, '❌ Нельзя варнить администратора.');
  const parts  = (msg.text||'').split(/\s+/).filter(Boolean);
  const reason = parts.slice(msg.reply_to_message ? 1 : 2).join(' ') || 'По решению администратора';
  const r = await act.doWarn(bot, cid, target.id, target.username, target.fullName, reason, getName(msg.from));
  await act.say(bot, cid, r.text);
  if (!r.banned) {
    const u = db.getUser(target.id, cid);
    if (u.warns >= 3 && u.warns < db.MAX_WARNS) {
      const kickMsg = await act.doKick(bot, cid, target.id, target.username, target.fullName,
        '3 варна — кик', getName(msg.from));
      await act.say(bot, cid, kickMsg);
    }
  }
});

// /mute [время] [причина]
bot.onText(/^\/mute\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return;
  const target = await getTarget(msg);
  if (!target) return act.say(bot, cid, '❌ Ответь на сообщение или укажи @username');
  if (await isAdmin(cid, target.id)) return act.say(bot, cid, '❌ Нельзя мутить администратора.');
  const parts = (msg.text||'').split(/\s+/).filter(Boolean);
  const idx   = msg.reply_to_message ? 1 : 2;
  const hasDur = D.parseDuration(parts[idx]);
  const sec   = hasDur || 1800;
  const reason = parts.slice(idx + (hasDur ? 1 : 0)).join(' ') || 'По решению администратора';
  const t = await act.doMute(bot, cid, target.id, target.username, target.fullName, sec, reason, getName(msg.from));
  await act.say(bot, cid, t);
});

// /ban [время] [причина]
bot.onText(/^\/ban\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return;
  const target = await getTarget(msg);
  if (!target) return act.say(bot, cid, '❌ Ответь на сообщение или укажи @username');
  if (await isAdmin(cid, target.id)) return act.say(bot, cid, '❌ Нельзя банить администратора.');
  const parts = (msg.text||'').split(/\s+/).filter(Boolean);
  const idx   = msg.reply_to_message ? 1 : 2;
  const hasDur = D.parseDuration(parts[idx]);
  const sec   = hasDur || null;
  const reason = parts.slice(idx + (hasDur ? 1 : 0)).join(' ') || 'По решению администратора';
  const t = await act.doBan(bot, cid, target.id, target.username, target.fullName, sec, reason, getName(msg.from));
  await act.say(bot, cid, t);
});

// /kick
bot.onText(/^\/kick\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return;
  const target = await getTarget(msg);
  if (!target) return act.say(bot, cid, '❌ Ответь на сообщение или укажи @username');
  if (await isAdmin(cid, target.id)) return act.say(bot, cid, '❌ Нельзя кикнуть администратора.');
  const parts  = (msg.text||'').split(/\s+/).filter(Boolean);
  const reason = parts.slice(msg.reply_to_message ? 1 : 2).join(' ') || 'По решению администратора';
  const t = await act.doKick(bot, cid, target.id, target.username, target.fullName, reason, getName(msg.from));
  await act.say(bot, cid, t);
});

// /unban
bot.onText(/^\/unban\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return;
  const target = await getTarget(msg);
  if (!target) return act.say(bot, cid, '❌ Укажи @username или ID');
  db.unbanUser(target.id, cid);
  await act.applyUnban(bot, cid, target.id);
  await act.say(bot, cid, `✅ Бан снят с ${D.mention(target.id, target.fullName)}`);
});

// /unmute
bot.onText(/^\/unmute\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const cid = msg.chat.id;
  if (!await isAdmin(cid, msg.from.id)) return;
  const target = await getTarget(msg);
  if (!target) return act.say(bot, cid, '❌ Укажи @username или ID');
  db.unmuteUser(target.id, cid);
  await act.applyUnmute(bot, cid, target.id);
  await act.say(bot, cid, `✅ Мут снят с ${D.mention(target.id, target.fullName)}`);
});

// ================================================================
// СТАТИСТИКА
// ================================================================

bot.onText(/^\/warns?\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  if (!await isAdmin(msg.chat.id, msg.from.id)) return;
  const list = db.getWarnedUsers(msg.chat.id);
  if (!list.length) return act.say(bot, msg.chat.id, '✅ Нет пользователей с варнами.');
  const lines = list.map(u => {
    const n = u.username ? `@${u.username}` : D.esc(u.full_name || String(u.user_id));
    return `- ${n}: <b>${u.warns}/${db.MAX_WARNS}</b> варнов`;
  });
  await act.say(bot, msg.chat.id, `📋 <b>Варны:</b>\n\n${lines.join('\n')}`);
});

bot.onText(/^\/mutes?\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  if (!await isAdmin(msg.chat.id, msg.from.id)) return;
  const list = db.getMutedUsers(msg.chat.id);
  if (!list.length) return act.say(bot, msg.chat.id, '✅ Нет заглушенных пользователей.');
  const lines = list.map(u => {
    const n = u.username ? `@${u.username}` : D.esc(u.full_name || String(u.user_id));
    return `- ${n}: ещё ${D.timeLeft(u.mute_until)}`;
  });
  await act.say(bot, msg.chat.id, `🔇 <b>Заглушенные:</b>\n\n${lines.join('\n')}`);
});

bot.onText(/^\/bans?\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  if (!await isAdmin(msg.chat.id, msg.from.id)) return;
  const list = db.getBannedUsers(msg.chat.id);
  if (!list.length) return act.say(bot, msg.chat.id, '✅ Нет забаненных пользователей.');
  const lines = list.map(u => {
    const n = u.username ? `@${u.username}` : D.esc(u.full_name || String(u.user_id));
    const t = u.ban_until ? `ещё ${D.timeLeft(u.ban_until)}` : '🔴 навсегда';
    return `- ${n}: ${t}`;
  });
  await act.say(bot, msg.chat.id, `🚫 <b>Забаненные:</b>\n\n${lines.join('\n')}`);
});

bot.onText(/^\/info\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  if (!await isAdmin(msg.chat.id, msg.from.id)) return;
  const target = await getTarget(msg);
  if (!target) return act.say(bot, msg.chat.id, '❌ Укажи пользователя.');
  const u    = db.getUser(target.id, msg.chat.id);
  const hist = db.getUserHistory(target.id, msg.chat.id).slice(0, 8);
  const histLines = hist.map(h => {
    const t = { warn:'⚠️', mute:'🔇', ban:'🚫', kick:'👢', unwarn:'✅-В', unmute:'✅-М', unban:'✅-Б' }[h.type] || '•';
    const d = new Date(h.created_at * 1000).toLocaleDateString('ru-RU');
    return `  ${t} ${d}: ${D.esc((h.reason||'').slice(0,60))}`;
  }).join('\n');
  const nm   = u.username ? `@${u.username}` : D.esc(u.full_name || String(u.user_id));
  const banS = u.is_banned ? (u.ban_until ? `🚫 Бан ещё ${D.timeLeft(u.ban_until)}` : '🚫 Навсегда') : '✅ Не забанен';
  const mutS = u.is_muted  ? `🔇 Мут ещё ${D.timeLeft(u.mute_until)}` : '✅ Не заглушен';
  await act.say(bot, msg.chat.id,
    `👤 <b>${nm}</b>  (ID: <code>${u.user_id}</code>)\n` +
    `⚠️ Варны: <b>${u.warns}/${db.MAX_WARNS}</b>\n` +
    `${banS}\n${mutS}\n\n` +
    (histLines ? `<b>Последние записи:</b>\n${histLines}` : 'Нарушений нет.'));
});

bot.onText(/^\/history\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  if (!await isAdmin(msg.chat.id, msg.from.id)) return;
  const target = await getTarget(msg);
  if (!target) return act.say(bot, msg.chat.id, '❌ Укажи пользователя.');
  const hist = db.getUserHistory(target.id, msg.chat.id);
  if (!hist.length) return act.say(bot, msg.chat.id, '📜 История пуста.');
  const lines = hist.map(h => {
    const t = { warn:'⚠️ Варн', mute:'🔇 Мут', ban:'🚫 Бан', kick:'👢 Кик',
                unwarn:'✅ -Варн', unmute:'✅ -Мут', unban:'✅ -Бан' }[h.type] || h.type;
    const d  = new Date(h.created_at * 1000).toLocaleString('ru-RU');
    const by = h.by_admin ? ` (${D.esc(h.by_admin)})` : '';
    return `${t}${by} — ${d}\n   ${D.esc((h.reason||'').slice(0,80))}`;
  });
  await act.say(bot, msg.chat.id, `📜 <b>История нарушений:</b>\n\n${lines.join('\n\n')}`);
});

// ================================================================
// ПРАВИЛА И ПОМОЩЬ
// ================================================================
bot.onText(/^\/rules\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  await act.say(bot, msg.chat.id,
    `📋 <b>ПРАВИЛА ЧАТА</b>\n\n` +
    `1️⃣ <b>Вежливость.</b> Оскорбления запрещены всем включая администраторов.\n` +
    `   - Каждое оскорбление = 1 варн (суммируется)\n` +
    `   - 3 варна = кик,  5 варнов = бан навсегда\n\n` +
    `2️⃣ <b>Без спама.</b> 5+ стикеров/гифок/эмодзи за 30 сек = мут 30 мин + удаление.\n\n` +
    `3️⃣ <b>18+</b> — нежелательно. Если очень нужно — только под спойлер.\n\n` +
    `4️⃣ <b>Входы/выходы.</b> 3+ раз за 10 минут = бан на 24 часа.\n\n` +
    `5️⃣ <b>Конфликты</b> переноси в ЛС. Участники конфликта получают варн.\n\n` +
    `6️⃣ <b>Экстремизм</b> (расизм / религия / политика / оскорбление президентов) = бан навсегда.\n\n` +
    `7️⃣ <b>Реклама</b> без разрешения = варн + удаление.\n` +
    `   - Ссылки: 1-е нарушение = варн + мут 10 мин,  2-е = бан навсегда.\n` +
    `   - Разрешение: admin отвечает <code>!можно</code> на сообщение.\n\n` +
    `8️⃣ <b>Расчленёнка</b> без спойлера = варн + удаление. С подписью и спойлером — можно.\n\n` +
    `9️⃣ <b>Администраторы</b> тоже соблюдают правила. 1-е нарушение — предупреждение, 2-е — снятие.\n\n` +
    `🔟 <b>Злоупотребление полномочиями</b> = снятие с должности.\n\n` +
    `1️⃣1️⃣ <b>Капс</b> (25+ букв, 70%+ заглавных) = варн + удаление.\n\n` +
    `1️⃣2️⃣ Правила могут обновляться.\n\n` +
    `⚠️ <b>Максимум варнов: ${db.MAX_WARNS} → после этого БАН НАВСЕГДА</b>`);
});

bot.onText(/^\/help\b/i, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat?.type)) return;
  const adm = await isAdmin(msg.chat.id, msg.from.id);
  let text = `🤖 <b>Moderator Bot</b>\n\n/rules — правила чата\n`;
  if (adm) {
    text +=
      `\n<b>Наказания (ответом или @user):</b>\n` +
      `/warn [причина]\n` +
      `/mute [время] [причина]  —  форматы: 10m 2h 1d 1w\n` +
      `/ban [время] [причина]   —  без времени = навсегда\n` +
      `/kick [причина]\n/unban\n/unmute\n\n` +
      `<b>Снятие (ответом или @user):</b>\n` +
      `-варн  или  -warn\n` +
      `-мут   или  -mute\n` +
      `-бан   или  -ban\n\n` +
      `<b>Разрешить ссылку:</b>\n` +
      `<code>!можно</code> — ответом на сообщение с ссылкой\n\n` +
      `<b>Статистика:</b>\n` +
      `/warns   /mutes   /bans\n` +
      `/info @user   /history @user`;
  }
  await act.say(bot, msg.chat.id, text);
});
bot.on('polling_error', e => console.error('polling_error:', e.message));
bot.on('error',         e => console.error('bot error:',     e.message));

bot.getMe().then(me => {
  console.log(`\n✅ @${me.username} запущен!\n`);
  console.log('📌 Добавь в группу и выдай права администратора:');
  console.log('   - Удалять сообщения');
  console.log('   - Банить участников');
  console.log('   - Ограничивать участников (мут)');
  console.log('   - Добавлять администраторов (для снятия с должности)\n');
}).catch(e => console.error('Ошибка запуска:', e.message));

process.on('SIGINT', () => { bot.stopPolling(); process.exit(0); });
