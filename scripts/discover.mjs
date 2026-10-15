import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ROOT, USER_AGENT, atomicWrite, readJson, sleep, imageUrl, isMain, printError } from './lib.mjs';

export const MAKER_PLATFORMS = ['pc', 'ios', 'android'];
const ENDPOINT = 'https://www.taptap.cn/webapiv2/maker/v1/app-list';
const X_UA = 'V=1&PN=WebApp&LANG=zh_CN&VN_CODE=100000000&LOC=CN&PLT=PC&DS=Android&OS=MacOS&OSV=10.15.7&DT=PC';

export function makerPageUrl(platform, next) {
  if (!MAKER_PLATFORMS.includes(platform)) throw new Error('平台只支持 pc、ios、android。');
  const url = new URL(next ?? `${ENDPOINT}?from=0&limit=50&sort=1&platform=${platform}`, ENDPOINT);
  const offset = url.searchParams.get('from');
  if (url.origin !== 'https://www.taptap.cn' || url.pathname !== new URL(ENDPOINT).pathname ||
      url.username || url.password || url.hash || !/^\d+$/.test(offset ?? '') ||
      !Number.isSafeInteger(Number(offset)) || url.searchParams.get('platform') !== platform ||
      url.searchParams.get('sort') !== '1') throw new Error('列表分页地址异常，停止抓取。');
  // 此接口 limit=100 会返回参数错误；响应长度也可能大于 limit，不能据此计算游标。
  url.searchParams.set('limit', '50');
  url.searchParams.delete('X-UA');
  return url;
}

export function parseMakerPage(payload, platform, offset) {
  if (payload.success !== true || !Array.isArray(payload.data?.list)) throw new Error('列表响应无效，已保留断点。');
  const games = new Map();
  for (const item of payload.data.list) {
    const appId = String(item.id ?? '');
    if (!/^\d{1,16}$/.test(appId) || typeof item.title !== 'string' || !item.title.trim()) throw new Error('列表含无效游戏，已停止，避免遗漏。');
    const iconUrl = imageUrl(item.icon?.url);
    const supportedPlatforms = [...new Set((item.supported_platforms ?? []).map(p => p.key).filter(p => MAKER_PLATFORMS.includes(p)))];
    games.set(appId, {
      appId, name: item.title.trim(), tapUrl: `https://www.taptap.cn/app/${appId}`,
      canView: item.can_view === true, miniappId: item.miniapp?.miniapp_id || null,
      supportedPlatforms, ...(iconUrl ? { iconUrl } : {})
    });
  }
  const nextPage = payload.data.next_page ? makerPageUrl(platform, payload.data.next_page).href : null;
  if (nextPage && (Number(new URL(nextPage).searchParams.get('from')) <= offset || !games.size)) throw new Error('分页游标未前进或空页仍有下一页，已停止。');
  const signature = createHash('sha256').update([...games.keys()].sort().join(',')).digest('hex');
  return { games: [...games.values()], nextPage, signature, received: payload.data.list.length };
}

export function mergeDiscoveries(states, baselineIds = new Set()) {
  const games = new Map();
  for (const state of states) for (const game of state.games) {
    const previous = games.get(game.appId);
    games.set(game.appId, {
      ...previous, ...game, canView: game.canView || previous?.canView || false,
      miniappId: game.miniappId || previous?.miniappId || null,
      supportedPlatforms: [...new Set([...(previous?.supportedPlatforms ?? []), ...game.supportedPlatforms])],
      listedOn: [...new Set([...(previous?.listedOn ?? []), state.platform])]
    });
  }
  const list = [...games.values()];
  const added = list.filter(game => !baselineIds.has(game.appId));
  const report = {
    updatedAt: new Date().toISOString(), complete: states.every(state => state.complete),
    scope: `TapTap Maker app-list, sort=1; platforms=${states.map(state => state.platform).join(',')}`,
    uniqueGames: list.length, eligibleMiniapps: list.filter(game => game.canView && game.miniappId).length,
    baselineGames: baselineIds.size, newGames: added.length,
    baselineNotReturned: [...baselineIds].filter(id => !games.has(id)),
    platforms: states.map(state => ({
      platform: state.platform, complete: state.complete, pages: state.pages.length,
      games: state.games.length, exclusiveGames: state.games.filter(game => games.get(game.appId).listedOn.length === 1).length,
      nextPage: state.nextPage
    }))
  };
  return { report, games: list, added };
}

export async function discoverMaker({
  platforms = MAKER_PLATFORMS, outputDir = path.join(ROOT, '.local/maker-platforms'), fresh = false,
  request = fetch, wait = sleep, delayMs = 3000, shouldStop = () => false,
  onProgress = progress => console.log(JSON.stringify(progress))
} = {}) {
  if (!platforms.length || new Set(platforms).size !== platforms.length || platforms.some(p => !MAKER_PLATFORMS.includes(p))) throw new Error('平台参数无效。');
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('请求间隔无效。');
  const config = await readJson(path.join(ROOT, 'config/boards.json'), { boards: [] });
  const baselineIds = new Set((config.boards.find(b => b.id === 'hot')?.games ?? []).map(game => String(game.appId)));
  const states = [];
  for (const platform of platforms) {
    const saved = fresh ? null : await readJson(path.join(outputDir, `${platform}.json`), null);
    if (saved && (saved.schemaVersion !== 1 || saved.platform !== platform || !Array.isArray(saved.pages) || !Array.isArray(saved.games))) throw new Error(`${platform} 断点格式无效。`);
    states.push(saved ?? {
      schemaVersion: 1, platform, startedAt: new Date().toISOString(), complete: false,
      nextPage: makerPageUrl(platform).href, pages: [], games: []
    });
  }
  const save = async (file, data) => atomicWrite(path.join(outputDir, file), JSON.stringify(data, null, 2) + '\n', 0o600);
  const saveMerged = async () => {
    const { report, games, added } = mergeDiscoveries(states, baselineIds);
    await save('games.json', { ...report, games });
    await save('new-games.json', { updatedAt: report.updatedAt, complete: report.complete, baselineGames: baselineIds.size, games: added });
    await save('report.json', report);
    return report;
  };
  // 新一轮先重置所有所选平台的断点，避免中断后混入上一轮已完成的平台。
  if (fresh) for (const state of states) await save(`${state.platform}.json`, state);
  let nextStart = Date.now() + delayMs, requests = 0, report;
  try {
    for (const state of states) {
      const games = new Map(state.games.map(game => [game.appId, game]));
      while (!state.complete && !shouldStop()) {
        const url = makerPageUrl(state.platform, state.nextPage);
        const offset = Number(url.searchParams.get('from'));
        if (state.pages.some(page => page.from === offset)) throw new Error('分页游标重复，已停止。');
        await wait(Math.max(0, nextStart - Date.now()));
        if (shouldStop()) break;
        nextStart = Date.now() + delayMs;
        url.searchParams.set('X-UA', X_UA);
        // 公开列表独立请求，不加载开发者 Cookie、PAT 或其他环境凭证。
        const response = await request(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(40000), redirect: 'error'
        });
        requests++;
        if (!response.ok) throw new Error(`列表 HTTP ${response.status}，停止抓取，不自动重试。`);
        const page = parseMakerPage(await response.json(), state.platform, offset);
        if (page.nextPage && state.pages.some(p => p.signature === page.signature)) throw new Error('列表重复返回同一页，已停止。');
        const before = games.size;
        for (const game of page.games) games.set(game.appId, game);
        state.pages.push({ from: offset, received: page.received, added: games.size - before, signature: page.signature });
        state.games = [...games.values()];
        state.nextPage = page.nextPage;
        state.complete = !page.nextPage;
        state.updatedAt = new Date().toISOString();
        await save(`${state.platform}.json`, state);
        if (requests % 10 === 0 || state.complete) await saveMerged();
        onProgress({ platform: state.platform, from: offset, received: page.received, unique: games.size, pages: state.pages.length, complete: state.complete });
      }
      if (shouldStop()) break;
    }
  } finally {
    report = await saveMerged();
  }
  return report;
}

if (isMain(import.meta.url)) {
  let interrupted = false;
  process.once('SIGINT', () => { interrupted = true; });
  process.once('SIGTERM', () => { interrupted = true; });
  const { values } = parseArgs({ options: {
    platforms: { type: 'string' }, output: { type: 'string' }, fresh: { type: 'boolean', default: false }
  } });
  discoverMaker({
    ...(values.platforms ? { platforms: values.platforms.split(',') } : {}),
    ...(values.output ? { outputDir: path.resolve(values.output) } : {}),
    fresh: values.fresh, shouldStop: () => interrupted
  }).then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (interrupted) process.exitCode = 130;
  }).catch(printError);
}
