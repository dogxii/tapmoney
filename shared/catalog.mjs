import { imageUrl, validId, normalizeGames } from './config.mjs';
import { boardsOf, boardInfo, validateBoards } from './boards.mjs';
export { imageUrl } from './config.mjs';

export function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || input.boards === undefined && (!Array.isArray(input.games) || !Array.isArray(input.authors))) throw new Error('缺少榜单配置。');
  const boards = validateBoards(input.boards === undefined ? boardsOf(input) : input.boards);
  return { boards: boards.map(board => ({ ...boardInfo(board), ...normalizeCatalog(board) })) };
}

function normalizeCatalog(input) {
  const games = normalizeGames(input.games);
  if (!Array.isArray(input.authors) || input.authors.length > 300) throw new Error('作者列表最多支持 300 位。');
  const authors = normalizeAuthors(input.authors).map((author, index) => {
    const qq = String(input.authors[index].qq ?? '').trim();
    const avatarUrl = imageUrl(input.authors[index].avatarUrl);
    return { ...author, qq, avatarUrl: qq && avatarUrl === qqAvatarUrl(qq) ? null : avatarUrl };
  });
  const gameIds = new Set(games.map(game => game.appId));
  if (authors.some(author => author.gameIds.some(id => !gameIds.has(id)))) throw new Error('作者只能绑定已添加的游戏。');
  return { games, authors };
}

export function tapProfileUrl(value) {
  try {
    const url = new URL(value, 'https://www.taptap.cn');
    if (url.protocol !== 'https:' || !['www.taptap.cn', 'taptap.cn'].includes(url.hostname) || !/^\/(user|developer)\/\d+\/?$/.test(url.pathname)) return null;
    return `https://www.taptap.cn${url.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

export function qqAvatarUrl(qq) {
  if (!/^[1-9]\d{4,11}$/.test(String(qq))) throw new Error('QQ 号需要填写 5–12 位数字。');
  return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`;
}

export function normalizeAuthors(list) {
  if (!Array.isArray(list)) throw new Error('authors 需要是作者数组。');
  const ids = new Set();
  return list.map(item => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.id ?? '') || ids.has(item.id)) throw new Error('作者 id 需要唯一，只能包含字母、数字、下划线或短横线。');
    ids.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim()) throw new Error(`作者 ${item.id} 缺少昵称。`);
    const qq = String(item.qq ?? '').trim();
    const fallback = qq ? qqAvatarUrl(qq) : null;
    const avatarUrl = imageUrl(item.avatarUrl) ?? fallback;
    if (item.avatarUrl && !imageUrl(item.avatarUrl)) throw new Error(`作者 ${item.id} 的头像必须是 HTTPS 图片链接。`);
    const tapUrl = item.tapUrl ? tapProfileUrl(item.tapUrl) : null;
    if (item.tapUrl && !tapUrl) throw new Error(`作者 ${item.id} 的 TapTap 主页链接无效。`);
    if (!Array.isArray(item.gameIds)) throw new Error(`作者 ${item.id} 缺少 gameIds 数组。`);
    return { id: item.id, name: item.name.trim().slice(0, 64), avatarUrl, tapUrl, gameIds: [...new Set(item.gameIds.map(id => validId(id, 'gameIds')))] };
  });
}

function decode(value) {
  return String(value ?? '').replace(/&(?:amp|quot|apos|lt|gt);/g, match => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }[match])).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function attribute(tag, name) {
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gs)) if (match[1] === name) return decode(match[3]);
  return null;
}

function text(html) { return decode(html.replace(/<[^>]+>/g, '')).trim(); }

export function extractGameMetadata(appId, html) {
  let game;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attribute(match[1], 'type') !== 'application/ld+json') continue;
    try {
      const data = JSON.parse(match[2]);
      const entries = Array.isArray(data) ? data : data['@graph'] ?? [data];
      game = entries.find(entry => [entry['@type']].flat().includes('VideoGame')) ?? game;
    } catch { /* 单个无效 JSON-LD 不影响其余公开数据。 */ }
  }
  if (!game) throw new Error('公开游戏页没有 VideoGame 数据。');
  const picture = typeof game.image === 'string' ? game.image : game.image?.url ?? game.image?.[0]?.url ?? game.image?.[0];
  const media = [];
  if (imageUrl(picture)) media.push({ kind: 'logo', url: imageUrl(picture) });
  for (const item of [game.screenshot ?? []].flat()) {
    const url = imageUrl(typeof item === 'string' ? item : item?.url);
    if (url && !media.some(saved => saved.url === url)) media.push({ kind: 'screenshot', url });
  }
  const authors = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!(attribute(match[1], 'class') ?? '').split(/\s+/).includes('developer-people-list__person')) continue;
    const tapUrl = tapProfileUrl(attribute(match[1], 'href'));
    if (!tapUrl?.includes('/user/')) continue;
    const nameBlock = match[2].match(/<(?:div|span)\b[^>]*class=["'][^"']*developer-people-list__person-name[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i);
    const name = nameBlock ? text(nameBlock[1]) : '';
    const avatarTag = [...match[2].matchAll(/<img\b[^>]*>/gi)].map(item => item[0]).find(tag => (attribute(tag, 'class') ?? '').split(/\s+/).includes('developer-people-list__avatar'));
    const avatarUrl = avatarTag ? imageUrl(attribute(avatarTag, 'data-src') ?? attribute(avatarTag, 'src')) : null;
    if (name) authors.push({ id: `tap-${tapUrl.split('/').at(-1)}`, name, avatarUrl, tapUrl });
  }
  if (!authors.length && game.author?.name) {
    const tapUrl = tapProfileUrl(game.author.url);
    if (tapUrl) authors.push({ id: `studio-${tapUrl.split('/').at(-1)}`, name: String(game.author.name).slice(0, 64), avatarUrl: null, tapUrl });
  }
  return { appId: String(appId), iconUrl: imageUrl(picture), media: media.slice(0, 30), authors: [...new Map(authors.map(author => [author.id, author])).values()] };
}

