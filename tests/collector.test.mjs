import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { periods, revenueTotal, TapTapClient, AuthenticationError } from '../scripts/lib.mjs';
import { collect } from '../scripts/collect.mjs';

test('北京时间跨年、跨月和闰年边界', () => {
  assert.deepEqual(periods(new Date('2026-12-31T16:05:00Z')), { today: '2027-01-01', asOf: '2026-12-31', monthStart: '2027-01-01' });
  assert.deepEqual(periods(new Date('2024-02-29T16:05:00Z')), { today: '2024-03-01', asOf: '2024-02-29', monthStart: '2024-03-01' });
});

test('优先读取报表合计，金额缺失不转成零', () => {
  assert.equal(revenueTotal({ total: '0', list: [{ revenue: 8 }] }), 0);
  assert.equal(revenueTotal({ list: [{ revenue: '3.2' }, { revenue: '-1.1' }] }), 2.1);
  assert.equal(revenueTotal({ total: {}, list: [{ revenue: '396.05' }] }), 396.05);
  assert.equal(revenueTotal({ total: null, list: [{ revenue: '' }, { revenue: '396.05' }, { revenue: '530.04' }] }), 926.09);
  assert.equal(revenueTotal({ total: null, list: [{ revenue: '' }] }), null);
  assert.equal(revenueTotal({ total: null, list: [{ revenue: '0' }] }), 0);
  assert.equal(revenueTotal({ total: { revenue: '18.20' }, list: [] }), 18.2);
  assert.throws(() => revenueTotal({ in_error: true, total: '0', list: [] }));
  assert.throws(() => revenueTotal({ total: '' }));
  assert.throws(() => revenueTotal({ list: [{ date: '2026-10-13' }] }));
  assert.throws(() => revenueTotal({}));
});

test('请求使用登录 Cookie、当前查询工作室和指定外部游戏 ID', async () => {
  let seen;
  const client = new TapTapClient({ TAPTAP_COOKIE: 'test-session=fixture', TAPTAP_REQUEST_DELAY_MS: '0' }, {
    wait: async () => {},
    request: async (url, options) => { seen = { url, options }; return new Response(JSON.stringify({ success: true, data: { total: '12.50' } }), { status: 200 }); }
  });
  assert.equal(await client.revenue('275960', '959305', '2026-10-13', '2026-10-13'), 12.5);
  assert.equal(seen.url.searchParams.get('developer_id'), '275960');
  assert.equal(seen.url.searchParams.get('app_id'), '959305');
  assert.equal(seen.options.headers.Cookie, 'test-session=fixture');
  assert.equal(seen.options.redirect, 'error');
  await assert.rejects(() => client.get('https://example.com/api/steal'));
});

test('认证失败不重试，HTTP 暂时错误允许重试', async () => {
  let count = 0;
  const expired = new TapTapClient({ TAPTAP_COOKIE: 'fixture', TAPTAP_REQUEST_DELAY_MS: '0' }, { wait: async () => {}, request: async () => { count++; return new Response('', { status: 401 }); } });
  await assert.rejects(() => expired.get('/api/user/v1/me'), AuthenticationError);
  assert.equal(count, 1);
  const recovering = new TapTapClient({ TAPTAP_COOKIE: 'fixture', TAPTAP_REQUEST_DELAY_MS: '0' }, { wait: async () => {}, request: async () => {
    count++; return count < 3 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ success: true, data: { id: '1' } }));
  } });
  assert.deepEqual(await recovering.get('/api/user/v1/me'), { id: '1' });
  assert.equal(count, 3);
});

test('HTTP 403 与登录过期区分，禁止错误推断游戏收益权限', async () => {
  const client = new TapTapClient({ TAPTAP_COOKIE: 'fixture', TAPTAP_REQUEST_DELAY_MS: '0' }, { wait: async () => {}, request: async () => new Response('', { status: 403 }) });
  await assert.rejects(() => client.get('/api/mini-app/v1/ad/payout-report-data'), error => !(error instanceof AuthenticationError) && error.message.includes('403'));
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tapmoney-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'ranking.json');
}
const env = { TAPTAP_COOKIE: 'fixture-secret', TAPTAP_DEVELOPER_ID: '275960' };
const game = { appId: '959305', name: '增量牧场', totalStartDate: '2020-01-01' };

test('月初不请求反向日期区间，公开快照不包含凭证或查询工作室', async t => {
  const outputFile = await fixture(t);
  const calls = [];
  const catalog = {
    games: { '959305': { iconUrl: 'https://example.com/game.png', authorIds: ['maker'] } },
    authors: [{ id: 'maker', name: '作者', avatarUrl: 'https://example.com/avatar.png', tapUrl: 'https://www.taptap.cn/user/1', extra: 'must-not-leak' }]
  };
  const snapshot = await collect({ catalog, env, games: [game], now: new Date('2026-10-31T16:05:00Z'), outputFile, client: {
    get: async () => ({}), revenue: async (...args) => { calls.push(args); return 10; }
  } });
  assert.equal(calls.length, 2);
  assert.equal(snapshot.games[0].revenue.month, 0);
  assert.equal(snapshot.monthStart, '2026-11-01');
  assert.equal(snapshot.games[0].iconUrl, 'https://example.com/game.png');
  assert.deepEqual(snapshot.games[0].authorIds, ['maker']);
  assert.equal(snapshot.authors[0].name, '作者');
  const written = await readFile(outputFile, 'utf8');
  assert.ok(!written.includes('fixture-secret'));
  assert.ok(!written.includes('275960'));
  assert.ok(!written.includes('must-not-leak'));
});

test('部分失败保留日期和历史收益，新游戏失败保持 null', async t => {
  const outputFile = await fixture(t);
  await writeFile(outputFile, JSON.stringify({ games: [{ ...game, updatedAt: '2026-10-12T03:00:00Z', asOf: '2026-10-11', monthStart: '2026-10-01', revenue: { yesterday: 8, month: 50, total: 90 }, cookie: 'must-not-leak' }] }));
  const snapshot = await collect({ catalog: { games: {}, authors: [] }, env, games: [game, { ...game, appId: '2' }, { ...game, appId: '3' }], now: new Date('2026-10-14T03:00:00Z'), outputFile, client: {
    get: async () => ({}), revenue: async (dev, appId) => { if (appId !== '2') throw new Error('upstream failure'); return 2; }
  } });
  assert.equal(snapshot.games[0].status, 'stale');
  assert.equal(snapshot.games[0].asOf, '2026-10-11');
  assert.equal(snapshot.games[0].revenue.total, 90);
  assert.equal(snapshot.games[2].status, 'unavailable');
  assert.equal(snapshot.games[2].revenue.total, null);
  assert.ok(!(await readFile(outputFile, 'utf8')).includes('must-not-leak'));
});

test('认证中途失效或全部失败时不覆盖上次快照', async t => {
  const outputFile = await fixture(t);
  const previous = JSON.stringify({ games: [] });
  await writeFile(outputFile, previous);
  await assert.rejects(() => collect({ catalog: { games: {}, authors: [] }, env, games: [game], outputFile, client: { get: async () => ({}), revenue: async () => { throw new AuthenticationError(); } } }), AuthenticationError);
  assert.equal(await readFile(outputFile, 'utf8'), previous);
  await assert.rejects(() => collect({ catalog: { games: {}, authors: [] }, env, games: [game], outputFile, client: { get: async () => ({}), revenue: async () => { throw new Error('failure'); } } }));
  assert.equal(await readFile(outputFile, 'utf8'), previous);
});
