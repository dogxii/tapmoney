import { rankingUrl, adminEnabled } from './runtime.js';

const games = new Map();
const boardFile = () => `/data/boards/${location.pathname.replace(/^\/+|\/+$/g, '') || 'index'}.json`;
async function json(url, refresh = false) {
  const response = await fetch(url, { cache: refresh ? 'reload' : 'default',
    ...(refresh && new URL(url, location.href).origin === location.origin ? { headers: { 'Cache-Control': 'no-cache' } } : {}), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('数据暂时无法加载');
  return response.json();
}

export async function loadRanking(refresh = false) {
  games.clear();
  if (adminEnabled) {
    try { return await json(`${rankingUrl}?view=summary&path=${encodeURIComponent(location.pathname)}`, refresh); }
    catch { return json(boardFile(), refresh).catch(() => json('/data/ranking.json', refresh)); }
  }
  if (rankingUrl === '/data/ranking.json') return json(boardFile(), refresh).catch(() => json(rankingUrl, refresh));
  return json(rankingUrl, refresh);
}

export function loadGame(game, snapshot) {
  if (!snapshot.summary) return Promise.resolve(game);
  if (game.status === 'pending') return Promise.resolve({ ...game, history: [], media: game.iconUrl ? [{kind:'logo',url:game.iconUrl}] : [] });
  const key = `${snapshot.id}:${game.appId}:${snapshot.generatedAt}`;
  if (!games.has(key)) {
    const file = `/data/games/${snapshot.id}/${game.appId}.json`;
    const url = adminEnabled ? `/api/game?board=${encodeURIComponent(snapshot.id)}&id=${game.appId}` : file;
    const read = refresh => json(url, refresh).catch(error => { if (!adminEnabled) throw error; return json(file, refresh); });
    const task = read(false)
      .then(async data => {
        if (data.generatedAt !== snapshot.generatedAt) data = await read(true);
        if (data.game?.appId !== game.appId) throw new Error('游戏数据无效');
        return { ...data.game, name: game.name, iconUrl: game.iconUrl, authorIds: game.authorIds ?? [] };
      })
      .catch(error => { games.delete(key); throw error; });
    games.set(key, task);
  }
  return games.get(key);
}
