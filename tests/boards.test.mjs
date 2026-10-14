import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../shared/catalog.mjs';
import { boardAtPath, boardPath, boardSnapshot } from '../shared/boards.mjs';
import { publicRanking } from '../server/api.mjs';

const game = { appId: '1', name: '同一款游戏', totalStartDate: '2020-01-01' };
const author = { id: 'maker', name: '群友作者', gameIds: ['1'], qq: '12345678' };
const home = { id: 'home', slug: '', name: '群友榜', games: [game], authors: [author] };
const hot = { id: 'hot', slug: 'hot', name: '热门榜', games: [game], authors: [{ ...author, name: '热门作者', qq: '87654321' }] };

test('每榜接受 500 款游戏，超过上限拒绝且不影响另一榜', () => {
  const games=Array.from({length:500},(_,i)=>({...game,appId:String(i+1)}));
  const config=normalizeConfig({boards:[home,{...hot,games}]});
  assert.equal(config.boards[1].games.length,500);
  assert.deepEqual(config.boards[0],normalizeConfig({boards:[home]}).boards[0]);
  assert.throws(()=>normalizeConfig({boards:[home,{...hot,games:[...games,{...game,appId:'501'}]}]}));
});

test('旧单榜迁移到首页，热门榜为空；配置和静态快照使用相同的独立路径', () => {
  const config = normalizeConfig({ games: [game], authors: [author] });
  assert.deepEqual(config.boards.map(b => [boardPath(b), b.games.length]), [['/', 1], ['/hot', 0]]);
  assert.equal(boardAtPath(config.boards, '/')?.id, 'home');
  assert.equal(boardAtPath(config.boards, '/hot')?.id, 'hot');
  assert.equal(boardAtPath(config.boards, '/hot/')?.id, 'hot');
  for (const path of ['/missing', '/hot/deeper', '/hot//', '/HOT']) assert.equal(boardAtPath(config.boards, path), null);
  const doc = publicRanking({ games: [{ ...game, revenue: { total: 5 } }] }, config);
  const view = boardSnapshot(doc, doc.boards[0]);
  assert.equal(view.games.length, 1); assert.equal(view.name, '群友榜'); assert.ok(!('boards' in view));
  assert.deepEqual(doc.boards[1].games, []);
});

test('多榜允许同游戏和同作者 ID，但不允许跨榜绑定、重复路径、无首页和保留路径', () => {
  assert.equal(normalizeConfig({ boards: [home, hot] }).boards.length, 2);
  for (const boards of [
    [home, { ...hot, authors: [{ ...author, gameIds: ['2'] }] }],
    [home, { ...hot, slug: '' }], [home, { ...hot, id: 'home' }], [hot], [],
    [home, { ...hot, slug: 'api' }], [home, { ...hot, slug: 'data' }],
    [home, { ...hot, slug: '404' }], [home, { ...hot, slug: '../other' }],
    [home, { ...hot, slug: 'some/path' }], [home, { ...hot, slug: 'Mixed' }]
  ]) assert.throws(() => normalizeConfig({ boards }));
  for (const value of [{}, { revision: 1 }, { boards: null }]) assert.throws(() => normalizeConfig(value));
});

test('修改某榜的同名作者、累计日期、删游戏都不会影响另一个榜，新增榜不借用其他榜的历史', () => {
  const row = { ...game, authorIds: ['maker'], authorMode: 'manual', revenue: { yesterday: 3, month: 8, total: 20 }, history: [{ date: '2026-10-13', revenue: 3 }] };
  const snapshot = { schemaVersion: 2, generatedAt: '2026-10-14T03:00:00Z', asOf: '2026-10-13', boards: [{ ...home, games: [row] }, { ...hot, games: [{ ...row, revenue: { yesterday: 4, month: 9, total: 30 } }] }] };
  const config = normalizeConfig({ boards: [home, hot] });
  const unchanged = publicRanking(snapshot, config).boards[1];
  config.boards[0].authors[0].name = '改过的群友作者';
  config.boards[0].games[0].totalStartDate = '2026-01-01';
  const changed = publicRanking(snapshot, config);
  assert.equal(changed.boards[0].games[0].revenue.total, null);
  assert.deepEqual(changed.boards[0].games[0].history, []);
  assert.equal(changed.boards[0].authors[0].name, '改过的群友作者');
  assert.deepEqual(changed.boards[1], unchanged);
  assert.equal(changed.boards[1].authors[0].avatarUrl, 'https://q1.qlogo.cn/g?b=qq&nk=87654321&s=100');
  config.boards[0].authors = [];
  assert.deepEqual(publicRanking(snapshot, config).boards[0].authors, []);
  config.boards[0].games = [];
  assert.deepEqual(publicRanking(snapshot, config).boards[1], unchanged);
  config.boards.push({ ...hot, id: 'third', slug: 'third', name: '第三榜' });
  const third = publicRanking(snapshot, config).boards[2];
  assert.equal(third.games[0].status, 'pending');
  assert.equal(third.games[0].revenue.total, null);
});
