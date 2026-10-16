import { rankingUrl } from './runtime.js';
import { authorDetails } from '../shared/authors.mjs';

const details = new Map();
const boardFile = () => `/data/boards/${location.pathname.replace(/^\/+|\/+$/g, '') || 'index'}.json`;
async function json(url, refresh = false) {
  const response = await fetch(url, { cache: refresh ? 'reload' : 'default',
    ...(refresh && new URL(url, location.href).origin === location.origin ? { headers: { 'Cache-Control': 'no-cache' } } : {}), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('数据暂时无法加载');
  return response.json();
}

async function summary(url, refresh) {
  const compatible = data => !data.summary || data.boards?.some(board => board.authorCoverage) && !data.boards.some(board => board.authors?.some(author => !Array.isArray(author.gameIds)));
  let data = await json(url, refresh);
  if (!compatible(data)) data = await json(url, true);
  if (!compatible(data)) throw new Error('榜单摘要版本已更新');
  return data;
}

export async function loadRanking(refresh = false) {
  details.clear();
  if (rankingUrl === '/data/ranking.json') return summary(boardFile(), refresh).catch(() => json(rankingUrl, refresh));
  return json(rankingUrl, refresh);
}

function loadDetail(type, id, snapshot) {
  const key = `${type}:${snapshot.id}:${id}:${snapshot.generatedAt}`;
  if (!details.has(key)) {
    const file = `/data/${type}s/${snapshot.id}/${id}.json`;
    const read = refresh => json(file, refresh);
    details.set(key, read(false).then(async data => {
      if (data.generatedAt !== snapshot.generatedAt) data = await read(true);
      if ((data[type]?.appId ?? data[type]?.id) !== id) throw new Error('详情数据无效');
      return data;
    }).catch(error => { details.delete(key); throw error; }));
  }
  return details.get(key);
}

export function loadAuthor(author, snapshot) {
  return snapshot.summary ? loadDetail('author', author.id, snapshot) : Promise.resolve(authorDetails({...snapshot, boards:[snapshot]}, snapshot.id, author.id));
}

export function loadGame(game, snapshot) {
  if (!snapshot.summary) return Promise.resolve(game);
  if (game.status === 'pending') return Promise.resolve({ ...game, history: [], media: game.iconUrl ? [{kind:'logo',url:game.iconUrl}] : [] });
  return loadDetail('game', game.appId, snapshot).then(({game: saved}) => ({...saved, name:game.name, iconUrl:game.iconUrl, authorIds:game.authorIds ?? saved.authorIds ?? []}));
}
