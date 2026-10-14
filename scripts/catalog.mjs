import path from 'node:path';
import { ROOT, readJson, atomicWrite, validId, sleep, USER_AGENT, imageUrl, RateLimitError } from './lib.mjs';
import { normalizeAuthors, extractGameMetadata } from '../shared/catalog.mjs';
export { imageUrl, tapProfileUrl, qqAvatarUrl, normalizeAuthors, extractGameMetadata } from '../shared/catalog.mjs';

export async function buildCatalog(games, {
  authors, request = fetch, cacheFile = path.join(ROOT, '.local/game-metadata.json'), now = new Date(), refresh = false, wait = sleep
} = {}) {
  authors = normalizeAuthors(authors ?? []);
  const cache = await readJson(cacheFile, {});
  let changed = false;
  for (const game of games) {
    const saved = cache[game.appId];
    if (!refresh && saved && Array.isArray(saved.media) && now.valueOf() - Date.parse(saved.fetchedAt) < 7 * 86400000) continue;
    try {
      const response = await request(`https://www.taptap.cn/app/${validId(game.appId, 'appId')}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
      if (response.status === 429) throw new RateLimitError();
      if (!response.ok) throw new Error();
      const html = await response.text();
      if (html.length > 8 * 1024 * 1024) throw new Error();
      cache[game.appId] = { ...extractGameMetadata(game.appId, html), fetchedAt: now.toISOString() };
      changed = true;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      console.error(`游戏 ${game.appId} 的公开信息暂未更新，继续使用已保存信息。`);
    }
    await wait(3000);
  }
  if (changed) await atomicWrite(cacheFile, JSON.stringify(cache, null, 2) + '\n', 0o600);
  const profiles = new Map();
  const entries = {};
  for (const game of games) {
    const metadata = cache[game.appId];
    const bound = authors.filter(author => author.gameIds.includes(game.appId));
    const selected = bound.length ? bound : metadata?.authors ?? [];
    for (const profile of selected) {
      const { id, name, avatarUrl, tapUrl } = profile;
      profiles.set(id, { id, name, avatarUrl, avatarSourceUrl: avatarUrl, tapUrl });
    }
    const iconUrl = imageUrl(game.iconUrl) ?? metadata?.iconUrl ?? null;
    entries[game.appId] = { iconUrl, iconSourceUrl: iconUrl, media: [...(iconUrl ? [{kind: 'logo', url: iconUrl}] : []), ...(metadata?.media ?? []).filter(item => item.kind === 'screenshot')], authorIds: selected.map(author => author.id), authorMode: bound.length ? 'manual' : 'auto' };
  }
  return { games: entries, authors: [...profiles.values()] };
}
