import path from 'node:path';
import { ROOT, loadEnv, readJson, atomicWrite, periods, TapTapClient, AuthenticationError, RateLimitError, validId, revenueHistory, isMain, printError } from './lib.mjs';
import { buildCatalog } from './catalog.mjs';
import { loadConfig } from './config.mjs';
import { remoteConfig } from './sync.mjs';
import { configSource } from '../shared/config.mjs';
import { normalizeConfig } from '../shared/catalog.mjs';
import { boardsOf, boardInfo } from '../shared/boards.mjs';
import { publicRanking } from '../shared/snapshot.mjs';

function selectBatch(config, oldBoards, dates, size, force, onlyGameIds) {
  const selected = new Set();
  const todayStart = Date.parse(`${dates.today}T00:00:00+08:00`);
  for (const board of config.boards) {
    const oldRows = new Map((oldBoards.get(board.id)?.games ?? []).map(game => [game.appId, game]));
    const attemptedAt = game => Date.parse(oldRows.get(game.appId)?.lastAttemptAt ?? oldRows.get(game.appId)?.updatedAt) || 0;
    const due = board.games.filter(game => {
      if (onlyGameIds && !onlyGameIds.has(game.appId)) return false;
      const old = oldRows.get(game.appId);
      if (force || old?.totalStartDate !== game.totalStartDate) return true;
      if (old?.status === 'ok' && old.asOf === dates.asOf) return false;
      return attemptedAt(game) < todayStart;
    }).sort((a, b) => attemptedAt(a) - attemptedAt(b));
    for (const game of due) {
      if (selected.size === size) return selected;
      selected.add(`${board.id}:${game.appId}`);
    }
  }
  return selected;
}

async function concurrentMap(items, limit, run) {
  const results = new Array(items.length);
  let index = 0, failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && index < items.length) {
      const current = index++;
      try { results[current] = await run(items[current]); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}

export async function collect({ env, config, client, catalogBuilder = buildCatalog, now = new Date(), outputFile = path.join(ROOT, 'site/data/ranking.json'), force = false, onlyGameIds } = {}) {
  env ??= await loadEnv();
  const batchSize = Number(env.TAPMONEY_BATCH_SIZE ?? 40);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('TAPMONEY_BATCH_SIZE 必须是 1–500 的整数。');
  const concurrency = Number(env.TAPMONEY_CONCURRENCY ?? 1);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('TAPMONEY_CONCURRENCY 必须是 1–10 的整数。');
  config = normalizeConfig(config ?? await (configSource(env) === 'cloud' ? remoteConfig(env) : loadConfig()));
  const previous = await readJson(outputFile, { games: [] });
  const oldBoards = new Map(boardsOf(previous).map(board => [board.id, board]));
  const dates = periods(now);
  const allowed = onlyGameIds ? new Set([...onlyGameIds].map(String)) : null;
  const selected = selectBatch(config, oldBoards, dates, batchSize, force, allowed);
  let developerId;
  if (selected.size) {
    client ??= new TapTapClient(env);
    developerId = validId(env.TAPTAP_DEVELOPER_ID, 'TAPTAP_DEVELOPER_ID');
    // 认证或限流失败时不覆盖上一份快照。
    await client.get('/api/user/v1/me');
  }
  const retained = new Map(publicRanking(previous, config).boards.map(board => [board.id, board]));
  const metadataCache = {};
  for (const board of retained.values()) {
    const authors = new Map(board.authors.map(author => [author.id,author]));
    for (const game of board.games) if (game.metadataUpdatedAt) metadataCache[game.appId] = {
      appId:game.appId, name:game.name, iconUrl:game.iconUrl, media:game.media,
      authors:game.authorIds.map(id=>authors.get(id)).filter(Boolean), fetchedAt:game.metadataUpdatedAt
    };
  }
  const boards = [];
  let succeeded = 0;
  // 相同报表共用请求；收益区间和失败回退各榜独立。
  const reports = new Map();
  function query(method, ...args) {
    const key = JSON.stringify([method, ...args]);
    if (!reports.has(key)) reports.set(key, Promise.resolve().then(() => client[method](...args)));
    return reports.get(key);
  }
  for (const board of config.boards) {
    const kept = retained.get(board.id);
    const oldRows = new Map(kept.games.map(game => [game.appId, game]));
    const batch = board.games.filter(game => selected.has(`${board.id}:${game.appId}`));
    // 未轮到的游戏不请求资料页或收益接口。
    const catalog = batch.length ? await catalogBuilder(batch, { now, seed: metadataCache }) : { games: {}, authors: [] };
    const profiles = new Map(kept.authors.map(author => [author.id, author]));
    for (const author of catalog.authors) if (!profiles.has(author.id) || (author.metadataUpdatedAt ?? '') >= (profiles.get(author.id).metadataUpdatedAt ?? '')) profiles.set(author.id, author);
    const collected = await concurrentMap(batch, concurrency, async game => {
      const old = oldRows.get(game.appId);
      const metadata = catalog.games[game.appId];
      const base = {
        appId: game.appId, name: metadata?.name || old?.name || game.name, url: `https://www.taptap.cn/app/${game.appId}`,
        totalStartDate: game.totalStartDate,
        iconUrl: metadata?.iconUrl ?? old?.iconUrl ?? null,
        media: metadata?.media ?? old?.media ?? [],
        authorIds: metadata?.authorIds ?? old?.authorIds ?? [], authorMode: metadata?.authorMode ?? old?.authorMode ?? 'auto',
        ...(metadata?.metadataUpdatedAt || old?.metadataUpdatedAt ? {metadataUpdatedAt: metadata?.metadataUpdatedAt ?? old.metadataUpdatedAt} : {}),
        lastAttemptAt: now.toISOString()
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
        succeeded++;
        console.log(`已采集 ${board.name} · ${game.name}（${game.appId}）。`);
        return { ...base, status: 'ok', asOf: dates.asOf, monthStart: dates.monthStart, updatedAt: now.toISOString(), revenue: { yesterday, month, total }, history: report.history };
      } catch (error) {
        if (error instanceof AuthenticationError || error instanceof RateLimitError) throw error;
        console.error(`${board.name} · ${game.name}（${game.appId}）采集失败：${error.message} 保留该榜历史数据。`);
        return {
          ...base, status: old?.updatedAt ? 'stale' : 'unavailable',
          asOf: old?.asOf ?? null, monthStart: old?.monthStart ?? null, updatedAt: old?.updatedAt ?? null,
          history: revenueHistory({ list: old?.history ?? [] }, game.totalStartDate, old?.asOf ?? dates.asOf),
          revenue: {
            yesterday: old?.revenue?.yesterday ?? null,
            month: old?.revenue?.month ?? null,
            total: old?.revenue?.total ?? null
          }
        };
      }
    });
    const updated = new Map(collected.map(game => [game.appId, game]));
    const rows = board.games.map(game => {
      const old = oldRows.get(game.appId);
      return updated.get(game.appId) ?? { ...old, status: old.updatedAt && old.asOf !== dates.asOf ? 'stale' : old.status };
    });
    const used = new Set(rows.flatMap(game => game.authorIds));
    boards.push({ ...boardInfo(board), games: rows,
      authors: [...profiles.values()].filter(author => used.has(author.id)).map(({ id, name, avatarUrl, tapUrl, metadataUpdatedAt }) => ({ id, name, avatarUrl, tapUrl, ...(metadataUpdatedAt ? {metadataUpdatedAt} : {}) })) });
  }
  const snapshot = {
    schemaVersion: 2, generatedAt: selected.size ? now.toISOString() : previous.generatedAt ?? now.toISOString(), asOf: dates.asOf, monthStart: dates.monthStart,
    timezone: 'Asia/Shanghai', currency: 'CNY', source: 'TapTap 小游戏广告收益报表', boards
  };
  await atomicWrite(outputFile, JSON.stringify(snapshot, null, 2) + '\n');
  const pending = boards.flatMap(board => board.games).filter(game => game.status === 'pending').length;
  console.log(`已更新 ${boards.length} 个榜单：本批 ${succeeded}/${selected.size} 个游戏成功，待首次采集 ${pending} 个，统计截至 ${dates.asOf}。`);
  return snapshot;
}

if (isMain(import.meta.url)) collect({ force: process.argv.includes('--force') }).catch(printError);
