import path from 'node:path';
import { ROOT, loadEnv, loadGames, readJson, atomicWrite, periods, TapTapClient, AuthenticationError, validId, revenueHistory, isMain, printError } from './lib.mjs';
import { buildCatalog } from './catalog.mjs';
import { remoteConfig } from './sync.mjs';
import { configSource } from '../shared/config.mjs';

export async function collect({ env, games, client, catalog, now = new Date(), outputFile = path.join(ROOT, 'site/data/ranking.json') } = {}) {
  env ??= await loadEnv();
  let config;
  if (!games && configSource(env) === 'cloud') {
    config = await remoteConfig(env);
    games = config.games;
  }
  games ??= await loadGames();
  client ??= new TapTapClient(env);
  const developerId = validId(env.TAPTAP_DEVELOPER_ID, 'TAPTAP_DEVELOPER_ID');
  // 开始采集前确认身份，失败时保留上一次完整快照。
  await client.get('/api/user/v1/me');
  const previous = await readJson(outputFile, { games: [] });
  const retainMedia = [...previous.games.flatMap(game => [game.iconUrl, ...(game.media ?? []).map(item => item.url)]), ...(previous.authors ?? []).map(author => author.avatarUrl)];
  catalog ??= await buildCatalog(games, { now, retainMedia, ...(config ? { authors: config.authors } : {}) });
  const dates = periods(now);
  const oldRows = new Map(previous.games.map(game => [game.appId, game]));
  const rows = [];
  let succeeded = 0;
  for (const game of games) {
    const old = oldRows.get(game.appId);
    const base = {
      appId: game.appId, name: game.name, url: `https://www.taptap.cn/app/${game.appId}`,
      totalStartDate: game.totalStartDate,
      iconUrl: catalog.games[game.appId]?.iconUrl ?? old?.iconUrl ?? null,
      iconSourceUrl: catalog.games[game.appId]?.iconSourceUrl ?? old?.iconSourceUrl ?? null,
      media: catalog.games[game.appId]?.media ?? old?.media ?? [],
      authorIds: catalog.games[game.appId]?.authorIds ?? []
    };
    try {
      if (game.totalStartDate > dates.asOf) throw new Error('累计统计起始日期晚于昨日。');
      const queryDeveloperId = game.queryDeveloperId ?? developerId;
      const yesterday = await client.revenue(queryDeveloperId, game.appId, dates.asOf, dates.asOf);
      // 每月第一天还没有本月完整日报，不发送起始日期晚于结束日期的请求。
      const month = dates.monthStart > dates.asOf ? 0 :
        await client.revenue(queryDeveloperId, game.appId, dates.monthStart, dates.asOf);
      const report = client.report ? await client.report(queryDeveloperId, game.appId, game.totalStartDate, dates.asOf) :
        { total: await client.revenue(queryDeveloperId, game.appId, game.totalStartDate, dates.asOf), history: [] };
      const total = report.total;
      if (yesterday === null && month === null && total === null) throw new Error('该游戏没有取得任何数值收益记录。');
      rows.push({ ...base, status: 'ok', asOf: dates.asOf, monthStart: dates.monthStart, updatedAt: now.toISOString(), revenue: { yesterday, month, total }, history: report.history });
      succeeded++;
      console.log(`已采集 ${game.name}（${game.appId}）。`);
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      // 公开数据只使用白名单字段，凭证和 queryDeveloperId 不会进入站点目录。
      const matchingTotalStart = old?.totalStartDate === game.totalStartDate;
      rows.push({
        ...base, status: old?.updatedAt ? 'stale' : 'unavailable',
        asOf: old?.asOf ?? null, monthStart: old?.monthStart ?? null, updatedAt: old?.updatedAt ?? null,
        history: matchingTotalStart ? revenueHistory({ list: old?.history ?? [] }, game.totalStartDate, old?.asOf ?? dates.asOf) : [],
        revenue: {
          yesterday: old?.revenue?.yesterday ?? null,
          month: old?.revenue?.month ?? null,
          total: matchingTotalStart ? (old?.revenue?.total ?? null) : null
        }
      });
      console.error(`${game.name}（${game.appId}）采集失败：${error.message} 保留历史数据。`);
    }
  }
  if (!succeeded && games.length) throw new Error('全部游戏采集失败，静态数据未更新，网站继续使用上一次快照。');
  const snapshot = {
    schemaVersion: 1, generatedAt: now.toISOString(), asOf: dates.asOf, monthStart: dates.monthStart,
    timezone: 'Asia/Shanghai', currency: 'CNY', source: 'TapTap 小游戏广告收益报表', games: rows,
    authors: catalog.authors.map(({ id, name, avatarUrl, avatarSourceUrl, tapUrl }) => ({ id, name, avatarUrl, avatarSourceUrl, tapUrl }))
  };
  await atomicWrite(outputFile, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`已更新静态 JSON：${succeeded}/${games.length} 个游戏成功，统计截至 ${dates.asOf}。`);
  return snapshot;
}

if (isMain(import.meta.url)) collect().catch(printError);
