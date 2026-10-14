import path from 'node:path';
import { ROOT, loadEnv, readJson, atomicWrite, periods, TapTapClient, AuthenticationError, RateLimitError, validId, revenueHistory, isMain, printError } from './lib.mjs';
import { buildCatalog } from './catalog.mjs';
import { loadConfig } from './config.mjs';
import { remoteConfig } from './sync.mjs';
import { configSource } from '../shared/config.mjs';
import { normalizeConfig } from '../shared/catalog.mjs';
import { boardsOf, boardInfo } from '../shared/boards.mjs';

function mediaUrls(board) {
  return [...board.games.flatMap(game => [game.iconUrl, ...(game.media ?? []).map(item => item.url)]), ...(board.authors ?? []).map(author => author.avatarUrl)];
}

export async function collect({ env, config, client, catalogBuilder = buildCatalog, now = new Date(), outputFile = path.join(ROOT, 'site/data/ranking.json') } = {}) {
  env ??= await loadEnv();
  config = normalizeConfig(config ?? await (configSource(env) === 'cloud' ? remoteConfig(env) : loadConfig()));
  client ??= new TapTapClient(env);
  const developerId = validId(env.TAPTAP_DEVELOPER_ID, 'TAPTAP_DEVELOPER_ID');
  // 身份失效时保留上一次完整快照。
  await client.get('/api/user/v1/me');
  const previous = await readJson(outputFile, { games: [] });
  const oldBoards = new Map(boardsOf(previous).map(board => [board.id, board]));
  const retainMedia = boardsOf(previous).flatMap(mediaUrls);
  const dates = periods(now);
  const boards = [];
  let succeeded = 0, gameCount = 0;
  // 仅共用上游报表请求；榜单配置、作者和失败回退互不共用。
  const reports = new Map();
  function query(method, ...args) {
    const key = JSON.stringify([method, ...args]);
    if (!reports.has(key)) reports.set(key, Promise.resolve().then(() => client[method](...args)));
    return reports.get(key);
  }
  for (const board of config.boards) {
    const oldRows = new Map((oldBoards.get(board.id)?.games ?? []).map(game => [game.appId, game]));
    const catalog = await catalogBuilder(board.games, { now, retainMedia, authors: board.authors });
    retainMedia.push(...mediaUrls({ games: Object.values(catalog.games), authors: catalog.authors }));
    const rows = [];
    for (const game of board.games) {
      gameCount++;
      const old = oldRows.get(game.appId);
      const metadata = catalog.games[game.appId];
      const base = {
        appId: game.appId, name: game.name, url: `https://www.taptap.cn/app/${game.appId}`,
        totalStartDate: game.totalStartDate,
        iconUrl: metadata?.iconUrl ?? old?.iconUrl ?? null,
        iconSourceUrl: metadata?.iconSourceUrl ?? old?.iconSourceUrl ?? null,
        media: metadata?.media ?? old?.media ?? [],
        authorIds: metadata?.authorIds ?? [], authorMode: metadata?.authorMode ?? 'auto'
      };
      try {
        if (game.totalStartDate > dates.asOf) throw new Error('累计统计起始日期晚于昨日。');
        const queryDeveloperId = game.queryDeveloperId ?? developerId;
        const yesterday = await query('revenue', queryDeveloperId, game.appId, dates.asOf, dates.asOf);
        // 每月第一天没有本月完整日报，不发送反向日期区间。
        const month = dates.monthStart > dates.asOf ? 0 :
          await query('revenue', queryDeveloperId, game.appId, dates.monthStart, dates.asOf);
        const report = client.report ? await query('report', queryDeveloperId, game.appId, game.totalStartDate, dates.asOf) :
          { total: await query('revenue', queryDeveloperId, game.appId, game.totalStartDate, dates.asOf), history: [] };
        const total = report.total;
        if (yesterday === null && month === null && total === null) throw new Error('该游戏没有取得任何数值收益记录。');
        rows.push({ ...base, status: 'ok', asOf: dates.asOf, monthStart: dates.monthStart, updatedAt: now.toISOString(), revenue: { yesterday, month, total }, history: report.history });
        succeeded++;
        console.log(`已采集 ${board.name} · ${game.name}（${game.appId}）。`);
      } catch (error) {
        if (error instanceof AuthenticationError || error instanceof RateLimitError) throw error;
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
        console.error(`${board.name} · ${game.name}（${game.appId}）采集失败：${error.message} 保留该榜历史数据。`);
      }
    }
    boards.push({ ...boardInfo(board), games: rows,
      authors: catalog.authors.map(({ id, name, avatarUrl, avatarSourceUrl, tapUrl }) => ({ id, name, avatarUrl, avatarSourceUrl, tapUrl })) });
  }
  if (!succeeded && gameCount) throw new Error('全部游戏采集失败，静态数据未更新，网站继续使用上一次快照。');
  const snapshot = {
    schemaVersion: 2, generatedAt: now.toISOString(), asOf: dates.asOf, monthStart: dates.monthStart,
    timezone: 'Asia/Shanghai', currency: 'CNY', source: 'TapTap 小游戏广告收益报表', boards
  };
  await atomicWrite(outputFile, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`已更新 ${boards.length} 个榜单：${succeeded}/${gameCount} 个游戏成功，统计截至 ${dates.asOf}。`);
  return snapshot;
}

if (isMain(import.meta.url)) collect().catch(printError);
