import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makerPageUrl, parseMakerPage, mergeDiscoveries, discoverMaker } from '../scripts/discover.mjs';

const item = id => ({ id, title: `游戏 ${id}`, can_view: true, miniapp: { miniapp_id: `tapmc${id}` }, supported_platforms: [{ key: 'android' }, { key: 'ios' }] });
const payload = (ids, next = '') => ({ success: true, data: { list: ids.map(item), next_page: next } });
const pageUrl = (platform, offset) => `/webapiv2/maker/v1/app-list?sort=1&platform=${platform}&from=${offset}&limit=50`;
const response = body => ({ ok: true, json: async () => body });

test('跟随接口游标，响应条数不用于猜测下一页；重复 ID 去重', () => {
  const page = parseMakerPage(payload([1, 1, 2], pageUrl('ios', 50)), 'ios', 0);
  assert.equal(page.games.length, 2);
  assert.equal(page.received, 3);
  assert.equal(new URL(page.nextPage).searchParams.get('from'), '50');
  assert.equal(page.games[0].miniappId, 'tapmc1');
  assert.deepEqual(page.games[0].supportedPlatforms, ['android', 'ios']);
  assert.equal(parseMakerPage(payload([1]), 'ios', 50).nextPage, null);
});

test('拒绝跨域、切换平台、回退分页和异常空页，不能误报完成', () => {
  for (const next of ['https://example.com' + pageUrl('ios', 50), pageUrl('pc', 50), pageUrl('ios', -1), pageUrl('ios', '1e2')]) {
    assert.throws(() => makerPageUrl('ios', next));
  }
  assert.throws(() => parseMakerPage(payload([1], pageUrl('ios', 50)), 'ios', 50));
  assert.throws(() => parseMakerPage(payload([], pageUrl('ios', 50)), 'ios', 0));
  assert.throws(() => parseMakerPage({ success: false, data: { list: [] } }, 'ios', 0));
});

test('全平台按 ID 合并，保留名单平台归属和差集，不受每榜 5000 上限截断', () => {
  const pc = parseMakerPage(payload(Array.from({ length: 5001 }, (_, i) => i + 1)), 'pc', 0).games;
  const ios = parseMakerPage(payload([1, 6000]), 'ios', 0).games;
  const result = mergeDiscoveries([
    { platform: 'pc', games: pc, pages: [], complete: true, nextPage: null },
    { platform: 'ios', games: ios, pages: [], complete: true, nextPage: null }
  ], new Set(pc.map(game => game.appId)));
  assert.equal(result.report.uniqueGames, 5002);
  assert.equal(result.report.complete, true);
  assert.deepEqual(result.added.map(game => game.appId), ['6000']);
  assert.deepEqual(result.games.find(game => game.appId === '1').listedOn, ['pc', 'ios']);
  assert.equal(result.report.platforms[1].exclusiveGames, 1);
});

async function localOutput(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tapmoney-discover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('中断后从已保存的下一页续跑，跨页去重，不传登录凭证', async t => {
  const outputDir = await localOutput(t);
  const requests = [];
  const request = async (url, options) => {
    requests.push(Number(url.searchParams.get('from')));
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    return response(requests.length === 1 ? payload([1, 2], pageUrl('ios', 50)) : payload([2, 3]));
  };
  const options = { platforms: ['ios'], outputDir, request, delayMs: 0, wait: async () => {}, onProgress: () => {} };
  const first = await discoverMaker({ ...options, shouldStop: () => requests.length === 1 });
  assert.equal(first.complete, false);
  assert.equal(first.uniqueGames, 2);
  const final = await discoverMaker(options);
  assert.deepEqual(requests, [0, 50]);
  assert.equal(final.complete, true);
  assert.equal(final.uniqueGames, 3);
  await discoverMaker(options);
  assert.deepEqual(requests, [0, 50]);
});

test('429 立即停止，不重试或请求下个平台，保留可恢复断点', async t => {
  const outputDir = await localOutput(t);
  let calls = 0;
  await assert.rejects(discoverMaker({
    platforms: ['ios', 'android'], outputDir, delayMs: 0, wait: async () => {}, onProgress: () => {},
    request: async () => ++calls === 1 ? response(payload([1], pageUrl('ios', 50))) : { ok: false, status: 429 }
  }), /HTTP 429/);
  assert.equal(calls, 2);
  const saved = JSON.parse(await readFile(path.join(outputDir, 'ios.json'), 'utf8'));
  assert.equal(new URL(saved.nextPage).searchParams.get('from'), '50');
  assert.equal(saved.games.length, 1);
  const report = JSON.parse(await readFile(path.join(outputDir, 'report.json'), 'utf8'));
  assert.equal(report.complete, false);
});

test('上游不断返回重复页时停止，保留最后有效页', async t => {
  const outputDir = await localOutput(t);
  let calls = 0;
  await assert.rejects(discoverMaker({
    platforms: ['android'], outputDir, delayMs: 0, wait: async () => {}, onProgress: () => {},
    request: async () => response(payload([1], pageUrl('android', ++calls * 50)))
  }), /重复返回同一页/);
  assert.equal(calls, 2);
  const saved = JSON.parse(await readFile(path.join(outputDir, 'android.json'), 'utf8'));
  assert.equal(saved.pages.length, 1);
  assert.equal(saved.complete, false);
});

test('重新抓取中断后，未轮到的平台也从新断点开始', async t => {
  const outputDir = await localOutput(t);
  const options = { platforms: ['ios', 'android'], outputDir, delayMs: 0, wait: async () => {}, onProgress: () => {}, request: async () => response(payload([1])) };
  await discoverMaker(options);
  await discoverMaker({ ...options, fresh: true, shouldStop: () => true });
  const platforms = [];
  await discoverMaker({ ...options, request: async url => { platforms.push(url.searchParams.get('platform')); return response(payload([2])); } });
  assert.deepEqual(platforms, ['ios', 'android']);
  const saved = JSON.parse(await readFile(path.join(outputDir, 'games.json'), 'utf8'));
  assert.deepEqual(saved.games.map(game => game.appId), ['2']);
});
