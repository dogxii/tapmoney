import test from 'node:test';
import assert from 'node:assert/strict';
import { rankingRows, metricValue, periodGrowth } from '../site/data-utils.js';
import { rankingCsv } from '../site/export-data.js';

const snapshot = { asOf: '2026-10-13', monthStart: '2026-10-01' };
function game(id, current, prior) {
  return { appId: id, name: `游戏 ${id}`, asOf: snapshot.asOf, monthStart: snapshot.monthStart, totalStartDate: '2020-01-01', revenue: {yesterday: current, month: current + prior, total: current + prior}, history: [{date: '2026-10-12',revenue:prior},{date:'2026-10-13',revenue:current}] };
}

test('名次变化基于同一组游戏的真实前日报，缺日时不推算名次', () => {
  const games = [game('1', 70, 100), game('2', 90, 50), game('3', 0, 0)];
  const rows = rankingRows(games, 'yesterday', snapshot);
  assert.deepEqual(rows.map(row => [row.game.appId, row.rank, row.movement]), [['2',1,1],['1',2,-1],['3',3,0]]);
  assert.equal(rows[2].growth, null);
  games[2].history.shift();
  assert.ok(rankingRows(games, 'yesterday', snapshot).every(row => row.movement === null));
  games[2].asOf = '2026-10-12';
  assert.equal(metricValue(games[2], 'month', snapshot), null);
  assert.equal(rankingRows(games, 'yesterday', snapshot).at(-1).rank, null);
});

test('月度增长使用完整上月同期而非整月，月初和缺日保持空值', () => {
  const item = game('1', 70, 100); item.revenue.month = 260;
  item.history.push(...Array.from({length:13},(_, index)=>({date:`2026-09-${String(index+1).padStart(2,'0')}`,revenue:10})));
  assert.equal(periodGrowth(item,'month',snapshot),100);
  item.history.pop(); assert.equal(periodGrowth(item,'month',snapshot),null);
  assert.equal(periodGrowth(item,'month',{asOf:'2026-09-30',monthStart:'2026-10-01'}),null);
});

test('本月排行名次与昨天本月累计比较，跨月不比较两个不同月份', () => {
  const rows = rankingRows([game('1',100,150),game('2',200,100)],'month',snapshot);
  assert.deepEqual(rows.map(row => [row.game.appId,row.movement]),[['2',1],['1',-1]]);
  const first = {...snapshot,asOf:'2026-10-01'};
  const item=game('1',100,150); item.asOf=first.asOf; item.history=[{date:'2026-09-30',revenue:150},{date:'2026-10-01',revenue:100}];
  assert.equal(rankingRows([item],'month',first)[0].movement,null);
});

test('CSV 保留真实零、空值、负数，公式形式名称按文本导出', () => {
  const item=game('1',0,100); item.name='=HYPERLINK("bad")';
  const rows=rankingRows([item, {...game('2',2,1),asOf:'2026-10-11'}],'yesterday',snapshot);
  const csv=rankingCsv(rows,snapshot,'yesterday',new Map());
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"0","-100"'));
  assert.ok(csv.includes('"","2"'));
});
