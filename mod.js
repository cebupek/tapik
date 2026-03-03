const SAFE = [
  'youtube.com','youtu.be','spotify.com','soundcloud.com','deezer.com',
  'vk.com','vkvideo.ru','kinopoisk.ru','imdb.com','letterboxd.com',
  'netflix.com','hdrezka.ag','github.com','stackoverflow.com',
  'wikipedia.org','instagram.com','twitter.com','x.com',
  'twitch.tv','rutube.ru','tiktok.com','filmix.ac',
];

const AD_KW = [
  'minecraft','mine-','funtime','mineplay','mc.',
  'donate','donat','promo','ref=','referral',
  'casino','казино','crypto','nft','airdrop','forex','форекс',
  'cheat','hack','заработ','ставки',
];

function extractLinks(text) {
  if (!text) return [];
  const re = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})(\/\S*)?/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ full: m[0], domain: m[1].toLowerCase() });
  }
  return out;
}

function isSafe(domain) {
  return SAFE.some(s => domain === s || domain.endsWith('.' + s));
}

function isAd(text) {
  if (!text) return false;
  const links = extractLinks(text);
  if (!links.length) return false;
  for (const { full, domain } of links) {
    if (isSafe(domain)) continue;
    const lo = full.toLowerCase();
    if (AD_KW.some(k => lo.includes(k))) return true;
    if (lo.includes('t.me/') || lo.includes('telegram.me/')) return true;
    return true;
  }
  return false;
}

function hasLink(text) {
  return extractLinks(text || '').length > 0;
}

function fmtTime(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60), r = m % 60;
  return r ? h + ' ч ' + r + ' мин' : h + ' ч';
}

function fmtWarns(warns) {
  if (!warns.length) return 'нет активных варнов';
  return warns.map((w, i) => {
    const left = Math.max(0, w.expires_at - Date.now());
    const m = Math.ceil(left / 60000);
    const h = Math.floor(m / 60), r = m % 60;
    const t = h ? h + 'ч ' + r + 'мин' : r + 'мин';
    return (i+1) + '. ' + w.reason + ' (сгорит через ' + t + ')';
  }).join('\n');
}

module.exports = { extractLinks, isAd, hasLink, fmtTime, fmtWarns };