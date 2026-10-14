import { normalizeGames, validDate, imageUrl } from '../shared/config.mjs';
import { normalizeAuthors, normalizeConfig, extractGameMetadata } from '../shared/catalog.mjs';
import { mediaUrl, cleanMedia } from '../shared/media.mjs';
import { boardsOf, boardInfo, boardAtPath, validateBoards } from '../shared/boards.mjs';
import { collectionStatus, dispatchCollection } from './collection.mjs';
import { publicRanking } from '../shared/snapshot.mjs';
import { rankingSummary, gameDetails } from '../shared/public-data.mjs';
import { cachedPublic } from './public-cache.mjs';
export { publicRanking } from '../shared/snapshot.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});

export async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export async function authenticated(request, expected) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S{1,256})$/)?.[1];
  if (!token || !/^[a-f0-9]{64}$/.test(expected ?? '')) return false;
  const actual = await tokenHash(token);
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}


function cleanSnapshot(input) {
  if (!(input.schemaVersion === 1 && Array.isArray(input.games) || input.schemaVersion === 2 && Array.isArray(input.boards)) || !Number.isFinite(Date.parse(input.generatedAt)) || !validDate(input.asOf) || !validDate(input.monthStart)) throw new Error('快照格式无效。');
  const boards = validateBoards(boardsOf(input)).map(board => ({ ...boardInfo(board), ...cleanBoard(board, input.asOf) }));
  return { schemaVersion: 2, generatedAt: input.generatedAt, asOf: input.asOf, monthStart: input.monthStart, boards };
}

function cleanBoard(input, asOf) {
  // 先整体验证，保证同一榜内的游戏 ID 不重复。
  const bases = normalizeGames(input.games.map(game => ({ ...game, iconUrl: undefined })));
  const amount = value => value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : null;
  const games = input.games.map((game, index) => {
    const base = bases[index];
    const history = Array.isArray(game.history) ? game.history.filter(row => validDate(row.date) && row.date >= base.totalStartDate && row.date <= asOf && typeof row.revenue === 'number' && Number.isFinite(row.revenue)).map(({ date, revenue }) => ({ date, revenue })) : [];
    if (history.length > 20000) throw new Error('日报数量过多。');
    return {
      appId: base.appId, name: base.name, url: `https://www.taptap.cn/app/${base.appId}`, totalStartDate: base.totalStartDate,
      iconUrl: mediaUrl(game.iconUrl), iconSourceUrl: imageUrl(game.iconSourceUrl), media: cleanMedia(game.media), authorIds: (game.authorIds ?? []).filter(id => /^[\w-]{1,64}$/.test(id)),
      authorMode: game.authorMode === 'manual' ? 'manual' : 'auto',
      status: ['ok', 'stale', 'unavailable', 'pending'].includes(game.status) ? game.status : 'unavailable',
      asOf: validDate(game.asOf) ? game.asOf : null, monthStart: validDate(game.monthStart) ? game.monthStart : null,
      updatedAt: Number.isFinite(Date.parse(game.updatedAt)) ? game.updatedAt : null,
      ...(Number.isFinite(Date.parse(game.lastAttemptAt)) ? { lastAttemptAt: game.lastAttemptAt } : {}),
      revenue: { yesterday: amount(game.revenue?.yesterday), month: amount(game.revenue?.month), total: amount(game.revenue?.total) }, history
    };
  });
  const originals = input.authors ?? [];
  if (!Array.isArray(originals) || originals.length > 10000) throw new Error('作者列表过大。');
  const authors = normalizeAuthors(originals.map(author => ({ ...author, avatarUrl: null, qq: '', gameIds: [] }))).map(({ id, name, tapUrl }, index) => ({ id, name, avatarUrl: mediaUrl(originals[index].avatarUrl), avatarSourceUrl: imageUrl(originals[index].avatarSourceUrl), tapUrl }));
  return { games, authors };
}

async function readBody(request, limit = 1024 * 1024) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('缺少请求内容。');
  const chunks = []; let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); throw new Error('请求内容过大。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('请求需要有效 JSON。'); }
}

async function document(db, key) {
  // 一次查询读取主文档及分片，避免上传期间混读两个版本。
  const { results } = await db.prepare('SELECT key, body, revision FROM documents WHERE key = ? OR key GLOB ?').bind(key, `${key}:*`).all();
  const row = results.find(row => row.key === key);
  if (!row) return null;
  let value = JSON.parse(row.body);
  if (value.format === 'chunked-json-v1') {
    const pieces = new Map(results.map(row => [row.key, row.body]));
    value = JSON.parse(Array.from({ length: value.parts }, (_, index) => {
      const piece = pieces.get(`${key}:${index}`);
      if (piece === undefined) throw new Error('快照分片缺失。');
      return JSON.parse(piece);
    }).join(''));
  }
  return { ...value, revision: row.revision };
}

async function saveDocument(db, key, snapshot) {
  const text = JSON.stringify(snapshot), size = 512 * 1024;
  const now = new Date().toISOString();
  const statements = [db.prepare('DELETE FROM documents WHERE key GLOB ?').bind(`${key}:*`)];
  let body = text;
  if (text.length > size) {
    const parts = [];
    for (let offset = 0; offset < text.length; offset += size) parts.push(text.slice(offset, offset + size));
    // 分片编码为 JSON 字符串，跨片的 Unicode 代理对也能无损还原。
    parts.forEach((part, index) => statements.push(db.prepare('INSERT INTO documents (key, body, updated_at) VALUES (?, ?, ?)').bind(`${key}:${index}`, JSON.stringify(part), now)));
    body = JSON.stringify({ format: 'chunked-json-v1', parts: parts.length });
  }
  statements.push(db.prepare('INSERT INTO documents (key, body, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, revision = documents.revision + 1, updated_at = excluded.updated_at').bind(key, body, now));
  await db.batch(statements);
}

async function publicData(env, request) {
  const [config, stored] = await Promise.all([document(env.DB, 'config'), document(env.DB, 'snapshot')]);
  let snapshot = stored;
  if (!snapshot) {
    const response = await env.ASSETS.fetch(new Request(new URL('/data/ranking.json', request.url)));
    if (!response.ok) throw new Error('暂无收益数据。');
    snapshot = await response.json();
  }
  const { games, authors, ...common } = snapshot;
  const data = config ? publicRanking(snapshot, config) : { ...common, schemaVersion: 2, boards: boardsOf(snapshot) };
  return { data, version: `${config?.revision ?? 0}:${stored?.revision ?? 0}`, stored: Boolean(stored) };
}

async function projectedData(env, request, key, select, context) {
  // 版本号和摘要在一次查询中读取；命中后不读取整份收益历史。
  const { results } = await env.DB.prepare("SELECT key, CASE WHEN key IN ('config', 'snapshot') THEN NULL ELSE body END AS body, revision FROM documents WHERE key IN ('config', 'snapshot', ?) OR key GLOB ?").bind(key, `${key}:*`).all();
  const version = ['config', 'snapshot'].map(key => results.find(row => row.key === key)?.revision ?? 0).join(':');
  const root = results.find(row => row.key === key);
  if (root) {
    let value = JSON.parse(root.body);
    if (value.format === 'chunked-json-v1') value = JSON.parse(Array.from({length:value.parts}, (_, index) => JSON.parse(results.find(row => row.key === `${key}:${index}`).body)).join(''));
    if (value.version === version) return value.data;
  }
  const source = await publicData(env, request);
  const data = select(source.data);
  if (source.stored && data) {
    const saved = saveDocument(env.DB, key, { version: source.version, data }).catch(() => {});
    if (context?.waitUntil) context.waitUntil(saved); else await saved;
  }
  return data;
}

async function handle(request, env, context) {
  const url = new URL(request.url), route = url.pathname;
  if (!route.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (!env.DB) return json({ error: '管理服务尚未配置。' }, 503);
  const protectedRoute = route.startsWith('/api/admin/') || route.startsWith('/api/internal/');
  if (protectedRoute) {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: '请求来源无效。' }, 403);
    if (!await authenticated(request, env.ADMIN_TOKEN_HASH)) return json({ error: '管理 Token 无效。' }, 401);
  }
  if (route === '/api/admin/config' && request.method === 'GET') {
    const saved = await document(env.DB, 'config');
    return json({ ...normalizeConfig(saved ?? { games: [], authors: [] }), revision: saved?.revision ?? 0 });
  }
  if (route === '/api/admin/collect' && ['GET', 'POST'].includes(request.method)) {
    try {
      const result = request.method === 'POST' ? await dispatchCollection(env) : await collectionStatus(env);
      return json(result, request.method === 'POST' ? 202 : 200);
    } catch (error) {
      return json({ error: error.message }, 503);
    }
  }
  if (route === '/api/admin/config' && request.method === 'PUT') {
    const input = await readBody(request);
    if (!Number.isInteger(input.revision) || input.revision < 0) return json({ error: '缺少配置版本，请重新加载。' }, 400);
    const config = normalizeConfig(input);
    const body = JSON.stringify(config), now = new Date().toISOString();
    const result = input.revision === 0 ?
      await env.DB.prepare("INSERT OR IGNORE INTO documents (key, body, revision, updated_at) VALUES ('config', ?, 1, ?)").bind(body, now).run() :
      await env.DB.prepare("UPDATE documents SET body = ?, revision = revision + 1, updated_at = ? WHERE key = 'config' AND revision = ?").bind(body, now, input.revision).run();
    if (result.meta.changes !== 1) return json({ error: '配置已被其他会话修改，请重新加载后保存。' }, 409);
    return json({ ...config, revision: input.revision + 1 });
  }
  if (route === '/api/admin/game' && request.method === 'GET') {
    if (!/^\d{1,16}$/.test(url.searchParams.get('id') ?? '')) return json({ error: '游戏 ID 无效。' }, 400);
    const id = url.searchParams.get('id');
    const response = await fetch(`https://www.taptap.cn/app/${id}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return json({ error: '暂时无法获取游戏资料，可手动填写名称。' }, 502);
    const html = await response.text();
    const metadata = extractGameMetadata(id, html);
    let name = '';
    for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try { const entry = JSON.parse(match[1]); if (entry['@type'] === 'VideoGame') name = entry.name ?? name; } catch { /* 忽略无效条目 */ }
    }
    return json({ ...metadata, name });
  }
  if (route === '/api/internal/snapshot' && request.method === 'PUT') {
    const snapshot = cleanSnapshot(await readBody(request, 16 * 1024 * 1024));
    await saveDocument(env.DB, 'snapshot', snapshot);
    return json({ ok: true });
  }
  if (route === '/api/ranking' && ['GET', 'HEAD'].includes(request.method)) {
    const view = url.searchParams.get('view');
    if (view && view !== 'summary') return json({ error: '视图无效。' }, 400);
    const pathname = (url.searchParams.get('path') ?? '/').replace(/\/$/, '') || '/';
    if (!/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(pathname) || pathname.length > 50) return json({ error: '榜单路径无效。' }, 400);
    const key = view ? `/api/ranking?view=summary&path=${encodeURIComponent(pathname)}` : '/api/ranking';
    return cachedPublic(request, key, async () => {
      if (!view) return json((await publicData(env, request)).data);
      const data = await projectedData(env, request, `public:summary:${pathname}`, data => boardAtPath(data.boards, pathname) ? rankingSummary(data, pathname) : null, context);
      return data ? json(data) : json({ error: '榜单不存在。' }, 404);
    }, context);
  }
  if (route === '/api/game' && ['GET', 'HEAD'].includes(request.method)) {
    const board = url.searchParams.get('board'), id = url.searchParams.get('id');
    if (!/^[\w-]{1,64}$/.test(board ?? '') || !/^\d{1,16}$/.test(id ?? '')) return json({ error: '游戏或榜单 ID 无效。' }, 400);
    return cachedPublic(request, `/api/game?board=${board}&id=${id}`, async () => {
      const detail = await projectedData(env, request, `public:game:${board}:${id}`, data => gameDetails(data, board, id), context);
      return detail ? json(detail) : json({ error: '游戏不存在。' }, 404);
    }, context);
  }
  return json({ error: '接口不存在。' }, 404);
}

export default {
  async fetch(request, env, context) {
    try { return await handle(request, env, context); }
    catch (error) {
      if (request.method === 'PUT') return json({ error: error instanceof Error ? error.message : '请求无效。' }, 400);
      return json({ error: '暂时无法完成请求。' }, 503);
    }
  }
};
