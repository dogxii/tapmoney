import path from 'node:path';
import { ROOT, readJson, atomicWrite, validId, sleep, USER_AGENT, imageUrl, RateLimitError } from './lib.mjs';
import { extractGameMetadata } from '../shared/catalog.mjs';
export { imageUrl, tapProfileUrl, profileId, normalizeAuthors, extractGameMetadata } from '../shared/catalog.mjs';

export async function buildCatalog(games, {
  request = fetch, cacheFile = path.join(ROOT, '.local/game-metadata.json'), now = new Date(), refresh = false, wait = sleep,
  concurrency = 1, requestDelayMs = 3000, onProgress = () => {}, seed = {}
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5 || !Number.isFinite(requestDelayMs) || requestDelayMs < 0) throw new Error('公开资料采集参数无效。');
  const cache = await readJson(cacheFile, {});
  for (const [id, metadata] of Object.entries(seed)) if (!cache[id] || metadata.fetchedAt > cache[id].fetchedAt) cache[id] = metadata;
  const due = games.filter(game => {
    const saved = cache[game.appId];
    const age = now.valueOf() - Date.parse(saved?.fetchedAt);
    return refresh || !saved?.name || !Array.isArray(saved.media) || !Number.isFinite(age) || age < 0 || age >= 7 * 86400000;
  });
  let index = 0, changed = 0, failure, pacing = Promise.resolve(), saving = Promise.resolve(), nextStart = 0;
  const checkpoint = () => { const body = JSON.stringify(cache) + '\n'; saving = saving.then(() => atomicWrite(cacheFile, body, 0o600)); return saving; };
  const pace = () => {
    const turn = pacing.then(async () => { if (nextStart > Date.now()) await wait(nextStart - Date.now()); nextStart = Date.now() + requestDelayMs; });
    pacing = turn.catch(() => {}); return turn;
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, async () => {
    while (!failure && index < due.length) {
      const game = due[index++];
      try {
        await pace(); if (failure) break;
        const response = await request(`https://www.taptap.cn/app/${validId(game.appId, 'appId')}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
        if ([401, 403, 429].includes(response.status)) throw new RateLimitError();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        if (html.length > 8 * 1024 * 1024) throw new Error('页面过大');
        const metadata = extractGameMetadata(game.appId, html);
        if (!metadata.name) throw new Error('缺少官方名称');
        cache[game.appId] = { ...metadata, fetchedAt: now.toISOString() }; changed++;
        if (changed % 10 === 0) await checkpoint();
        onProgress({ appId: game.appId, completed: changed, remaining: due.length - index });
      } catch (error) {
        if (error instanceof RateLimitError) failure ??= error;
        else console.error(`游戏 ${game.appId} 的公开信息暂未更新，继续使用已保存信息。`);
      }
    }
  }));
  if (changed) await checkpoint();
  if (failure) throw failure;
  const profiles = new Map(), entries = {};
  for (const game of games) {
    const metadata = cache[game.appId];
    const selected = metadata?.authors ?? [];
    for (const profile of selected) {
      const saved = profiles.get(profile.id);
      const metadataUpdatedAt = [metadata.fetchedAt, profile.metadataUpdatedAt ?? ''].sort().at(-1);
      if (!saved || metadataUpdatedAt >= saved.metadataUpdatedAt) profiles.set(profile.id, {...profile, metadataUpdatedAt});
    }
    const iconUrl = metadata?.iconUrl ?? imageUrl(game.iconUrl);
    entries[game.appId] = { ...(metadata?.name ? {name: metadata.name} : {}), iconUrl,
      media: [...(iconUrl ? [{kind: 'logo', url: iconUrl}] : []), ...(metadata?.media ?? []).filter(item => item.kind === 'screenshot')],
      ...(metadata ? { authorIds: selected.map(author => author.id), metadataUpdatedAt: metadata.fetchedAt } : {}), authorMode: 'auto' };
  }
  return { games: entries, authors: [...profiles.values()] };
}
