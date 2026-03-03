require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const mod = require('./mod');
require('./server');



const TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

async function tg(method, params) {
  const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.description || 'tg error');
  return d.result;
}

const pending = new Map();

// Спам-счётчик в памяти — ключ: chatId_userId_type
// { n: число, lastAt: timestamp }
// Если прошло больше 10 секунд без сообщений этого типа — серия сбрасывается
const spamMap = new Map();
const SPAM_WINDOW = 10000;

function spamInc(chatId, userId, type) {
  const key = chatId + '_' + userId + '_' + type;
  const now = Date.now();
  const row = spamMap.get(key);
  let n;
  if (!row || (now - row.lastAt) > SPAM_WINDOW) {
    n = 1;
  } else {
    n = row.n + 1;
  }
  spamMap.set(key, { n, lastAt: now });
  return n;
}

function spamReset(chatId, userId, type) {
  // Сбрасываем к 5 — следующий стикер будет 6-м и удалится
  // Если обнулить до 0, человек снова получает 5 бесплатных
  const key = chatId + '_' + userId + '_' + type;
  spamMap.set(key, { n: 5, lastAt: Date.now() });
}

async function isAdmin(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return ['administrator', 'creator'].includes(m.status);
  } catch { return false; }
}

async function doMute(chatId, userId, ms) {
  const until = Math.floor((Date.now() + ms) / 1000);
  try {
    await tg('restrictChatMember', {
      chat_id: chatId, user_id: userId,
      permissions: {
        can_send_messages: false, can_send_audios: false,
        can_send_documents: false, can_send_photos: false,
        can_send_videos: false, can_send_video_notes: false,
        can_send_voice_notes: false, can_send_polls: false,
        can_send_other_messages: false, can_add_web_page_previews: false,
        can_change_info: false, can_invite_users: false, can_pin_messages: false,
      },
      until_date: until,
    });
    db.setMute(chatId, userId, ms);
    return true;
  } catch (e) { console.error('mute err:', e.message); return false; }
}

async function doUnmute(chatId, userId) {
  try {
    const chat = await tg('getChat', { chat_id: chatId });
    const p = chat.permissions || {};
    await tg('restrictChatMember', {
      chat_id: chatId, user_id: userId,
      permissions: {
        can_send_messages:         p.can_send_messages !== false,
        can_send_audios:           p.can_send_audios !== false,
        can_send_documents:        p.can_send_documents !== false,
        can_send_photos:           p.can_send_photos !== false,
        can_send_videos:           p.can_send_videos !== false,
        can_send_video_notes:      p.can_send_video_notes !== false,
        can_send_voice_notes:      p.can_send_voice_notes !== false,
        can_send_polls:            p.can_send_polls !== false,
        can_send_other_messages:   p.can_send_other_messages !== false,
        can_add_web_page_previews: p.can_add_web_page_previews !== false,
        can_change_info:           false,
        can_invite_users:          p.can_invite_users !== false,
        can_pin_messages:          false,
      },
    });
    db.delMute(chatId, userId);
    return true;
  } catch (e) { console.error('unmute err:', e.message); return false; }
}

function uname(user) {
  if (!user) return 'Неизвестный';
  if (user.username) return '@' + user.username;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'id' + user.id;
}

async function giveWarn(chatId, userId, displayName, reason) {
  db.addWarn(chatId, userId, reason);
  const warns = db.getWarns(chatId, userId);
  const cnt = warns.length;

  if (cnt >= 15) {
    let ms;
    if (reason.includes('реклам') || reason.includes('ссылк')) {
      const step = db.incMuteStep(chatId, userId);
      const steps = [15, 30, 45, 60, 90, 120];
      ms = steps[Math.min(step - 1, steps.length - 1)] * 60000;
    } else {
      ms = 8 * 60000;
    }
    const ok = await doMute(chatId, userId, ms);
    const txt = ok
      ? displayName + ' получил мут на ' + mod.fmtTime(ms) + ' — 15/15 варнов.'
      : 'Не смог замутить ' + displayName + ' — проверь права бота.';
    bot.sendMessage(chatId, txt);
    return;
  }

  bot.sendMessage(chatId, displayName + ', предупреждение ' + cnt + '/15 — ' + reason + '.');
}

setInterval(async () => {
  db.clearExpired();
  for (const row of db.getExpiredMutes()) {
    const ok = await doUnmute(row.chat_id, row.user_id);
    if (ok) {
      db.clearWarns(row.chat_id, row.user_id);
      try { bot.sendMessage(row.chat_id, 'Мут истёк — id' + row.user_id + ' снова может писать, варны сброшены.'); } catch {}
    }
  }
}, 15000);

async function checkSpam(msg, type, admin) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const n = spamInc(chatId, userId, type);

  if (n <= 5) return; // первые 5 — пропускаем

  // 6-й и дальше — удаляем
  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

  // На 6-м — варн и сброс счётчика в 0
  // После сброса человек может снова отправить 5 штук
  if (n === 6) {
    spamReset(chatId, userId, type);
    if (!admin) await giveWarn(chatId, userId, uname(msg.from), 'спам ' + type);
  }
}

bot.on('message', async (msg) => {
  if (!msg || !msg.chat || !msg.from) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || msg.caption || '').trim();
  const inGroup = ['group', 'supergroup'].includes(msg.chat.type);

  if (text.toLowerCase() === 'тапок') {
    bot.sendMessage(chatId, 'здесь 🥿');
    return;
  }

  if (text.toLowerCase() === '!моя стата') {
    const warns = db.getWarns(chatId, userId);
    const mute = db.getMute(chatId, userId);
    let muteStr = 'нет';
    if (mute && mute.unmute_at > Date.now()) {
      muteStr = 'ещё ' + mod.fmtTime(mute.unmute_at - Date.now());
    }
    const lines = [
      'Статистика:',
      'Варны (' + warns.length + '/15):',
      mod.fmtWarns(warns),
      'Мут: ' + muteStr,
    ];
    bot.sendMessage(chatId, lines.join('\n'));
    return;
  }

  if (!inGroup) return;

  const admin = await isAdmin(chatId, userId);

  if (text.startsWith('-варн') && admin) {
    const t = msg.reply_to_message;
    if (!t || !t.from) { bot.sendMessage(chatId, 'Ответь на сообщение пользователя.'); return; }
    const ok = db.removeOneWarn(chatId, t.from.id);
    bot.sendMessage(chatId, ok
      ? 'Один варн снят с ' + uname(t.from) + '.'
      : 'У ' + uname(t.from) + ' нет активных варнов.'
    );
    return;
  }

  if (text.toLowerCase() === '!снятьвсеварны' && admin) {
    const t = msg.reply_to_message;
    if (!t || !t.from) { bot.sendMessage(chatId, 'Ответь на сообщение пользователя.'); return; }
    db.clearWarns(chatId, t.from.id);
    bot.sendMessage(chatId, 'Все варны сняты с ' + uname(t.from) + '.');
    return;
  }

  if (text.startsWith('-мут') && admin) {
    const t = msg.reply_to_message;
    if (!t || !t.from) { bot.sendMessage(chatId, 'Ответь на сообщение пользователя.'); return; }
    const ok = await doUnmute(chatId, t.from.id);
    if (ok) {
      // Чистим все варны пользователя
      db.clearWarns(chatId, t.from.id);
    }
    bot.sendMessage(chatId, ok
      ? 'Мут снят с ' + uname(t.from) + ', все варны сброшены.'
      : 'Не удалось снять мут — проверь права бота.'
    );
    return;
  }

  if (text.toLowerCase() === '!можно' && admin) {
    if (msg.reply_to_message) {
      const key = chatId + '_' + msg.reply_to_message.message_id;
      const p = pending.get(key);
      if (p) {
        db.allowLink(chatId, p.link);
        pending.delete(key);
        bot.sendMessage(chatId, 'Ссылка добавлена в белый список.');
        return;
      }
    }
    bot.sendMessage(chatId, 'Ответь на моё сообщение о ссылке командой !можно');
    return;
  }

  if (msg.sticker) { await checkSpam(msg, 'sticker', admin); return; }
  if (msg.animation) { await checkSpam(msg, 'gif', admin); return; }

  if (msg.text) {
    const t = msg.text.trim();
    if (/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})+$/u.test(t)) {
      await checkSpam(msg, 'emoji', admin);
      return;
    }
  }

  if (mod.hasLink(text)) {
    const links = mod.extractLinks(text);
    for (const { full, domain } of links) {
      if (db.isAllowed(chatId, full) || db.isAllowed(chatId, domain)) continue;
      if (mod.isAd(full)) {
        try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
        const sent = await bot.sendMessage(chatId,
          (admin
            ? 'Удалил рекламную ссылку от ' + uname(msg.from) + '.'
            : uname(msg.from) + ', реклама запрещена.') +
          '\nМодератор: ответь !можно на это сообщение чтобы разрешить эту ссылку навсегда.'
        );
        const key = chatId + '_' + sent.message_id;
        pending.set(key, { link: full, userId });
        setTimeout(() => pending.delete(key), 5 * 60000);
        if (!admin) await giveWarn(chatId, userId, uname(msg.from), 'реклама');
        return;
      }
    }
  }

  if (text.includes('@')) {
    const adWords = ['заходи', 'вступай', 'подпишись', 'подписывайся', 'присоединяйся', 'канал', 'группа'];
    const re = /@([a-zA-Z0-9_]{5,})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      try {
        await bot.getChatMember(chatId, '@' + m[1]);
      } catch {
        if (!admin && adWords.some(w => text.toLowerCase().includes(w))) {
          try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
          await giveWarn(chatId, userId, uname(msg.from), 'реклама через упоминание');
          return;
        }
      }
    }
  }
});

bot.on('polling_error', e => console.error('polling:', e.message));
console.log('Тапок запущен 🥿');
