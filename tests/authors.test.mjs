import test from 'node:test';
import assert from 'node:assert/strict';
import { authorsRanking, authorDetails } from '../shared/authors.mjs';
import { rankingSummary } from '../shared/public-data.mjs';
import { chartSeries, rankingRows } from '../site/data-utils.js';
import { rankingCsv } from '../site/export-data.js';
const snapshot = {schemaVersion:2, generatedAt:'2026-10-14T03:00:00Z', asOf:'2026-10-13', monthStart:'2026-10-01'};
const profile = (id,name='同名作者') => ({id:`tap-${id}`,name,tapUrl:`https://www.taptap.cn/user/${id}`,avatarUrl:`https://img.tapimg.com/${id}.png`});
const game = (id,ids,revenue=10) => ({appId:String(id),name:`游戏${id}`,authorIds:ids,status:'ok',asOf:snapshot.asOf,monthStart:snapshot.monthStart,totalStartDate:'2020-01-01',
  revenue:{yesterday:revenue,month:revenue*5,total:revenue*10},history:[{date:'2026-10-12',revenue:5},{date:'2026-10-13',revenue}]});

test('按稳定身份分组，同名不合并，合作作品完整归属，单个作者不重复计入作品', () => {
  const board = {games:[game(1,['tap-1','tap-1','tap-2']),game(2,['tap-1'],20)],authors:[profile(1),profile(2)]};
  const [first,second] = authorsRanking(board,snapshot);
  assert.equal(first.gameCount,2); assert.equal(first.revenue.yesterday,30); assert.equal(second.gameCount,1); assert.equal(second.revenue.yesterday,10);
  assert.equal(first.name,second.name); assert.notEqual(first.id,second.id);
  assert.equal(first.growth.yesterday,200); // 合计 30 / 基准 10；不平均各作品增长率。
  assert.equal(first.previousRevenue.total,270);
  const ranked = rankingRows([first,second],'total',snapshot); assert.deepEqual(ranked.map(row=>row.game.id),['tap-1','tap-2']);
});

test('作者仅汇总当前榜作品，详情不包含其他榜或其他作者的游戏', () => {
  const data = {...snapshot,boards:[{id:'home',slug:'',name:'群友',games:[game(1,['tap-1'])],authors:[profile(1)]},
    {id:'hot',slug:'hot',name:'热门',games:[game(1,['tap-1']),game(2,['tap-1'],20)],authors:[profile(1)]}]};
  const home = authorDetails(data,'home','tap-1'),hot = authorDetails(data,'hot','tap-1');
  assert.equal(home.author.revenue.total,100); assert.equal(hot.author.revenue.total,300);
  assert.deepEqual(home.games.map(game=>game.appId),['1']); assert.equal(home.generatedAt,snapshot.generatedAt);
  assert.equal(authorDetails(data,'missing','tap-1'),null); assert.equal(authorDetails(data,'home','tap-2'),null);
  const summary = rankingSummary(data,'/hot'); assert.deepEqual(summary.boards[0].authors,[]);
  assert.equal(summary.boards[1].authors[0].gameCount,2); assert.ok(!('history' in summary.boards[1].authors[0]));
  assert.deepEqual(summary.boards[1].authorCoverage,{assigned:2,total:2});
});

test('未知收益不当零，过期日期不混合为当前合计，真实零与缺少基准正确区分', () => {
  const first = game(1,['tap-1'],0),other = game(2,['tap-1'],20);
  other.revenue.month=null;
  let [author] = authorsRanking({games:[first,other],authors:[profile(1)]},snapshot);
  assert.equal(author.revenue.month,null);assert.equal(author.metricCounts.month,1);assert.equal(author.growth.month,null);
  assert.equal(author.revenue.yesterday,20);
  other.asOf='2026-10-12';
  [author] = authorsRanking({games:[first,other],authors:[profile(1)]},snapshot);
  assert.equal(author.revenue.total,null);assert.equal(author.metricCounts.total,1);
  [author] = authorsRanking({games:[first],authors:[profile(1)]},snapshot);
  assert.equal(author.revenue.yesterday,0); assert.equal(author.growth.yesterday,-100);
});

test('月增长用各作品完整上月同期基准求和，不能平均增长率', () => {
  const first=game(1,['tap-1']),second=game(2,['tap-1'],30);
  for(const [work,value] of [[first,1],[second,10]]) work.history.push(...Array.from({length:13},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,'0')}`,revenue:value})));
  const [author]=authorsRanking({games:[first,second],authors:[profile(1)]},snapshot);
  assert.equal(author.growth.month,(200-143)/143*100);
  second.history.pop();
  assert.equal(authorsRanking({games:[first,second],authors:[profile(1)]},snapshot)[0].growth.month,null);
});

test('汇总曲线保留日期缺口，累计曲线包含每款作品在共同日期之前的收益', () => {
  const first=game(1,['tap-1']),second=game(2,['tap-1']);
  first.history=[{date:'2026-10-10',revenue:1},{date:'2026-10-12',revenue:3},{date:'2026-10-13',revenue:4}];
  second.history=[{date:'2026-10-11',revenue:2},{date:'2026-10-12',revenue:5},{date:'2026-10-13',revenue:6}];
  const data={...snapshot,boards:[{id:'home',games:[first,second],authors:[profile(1)]}]};
  const {author}=authorDetails(data,'home','tap-1');
  assert.deepEqual(author.history,[{date:'2026-10-12',revenue:8,cumulativeRevenue:11},{date:'2026-10-13',revenue:10,cumulativeRevenue:21}]);
  assert.deepEqual(chartSeries(author.history,'cumulative',0,snapshot.asOf).map(row=>row.revenue),[11,21]);
  second.history=[];assert.deepEqual(authorDetails(data,'home','tap-1').author.history,[]);
});

test('作者 CSV 使用作者身份和作品数，公式昵称按文本导出', () => {
  const [author] = authorsRanking({games:[game(1,['tap-1'])],authors:[profile(1,'=HYPERLINK("bad")')]},snapshot);
  const csv=rankingCsv(rankingRows([author],'total',snapshot),snapshot,'total',new Map(),true);
  assert.ok(csv.includes('作者 ID'));assert.ok(csv.includes('作品数'));assert.ok(csv.includes('tap-1'));assert.ok(csv.includes("'=HYPERLINK"));assert.ok(!csv.includes('undefined'));
});
