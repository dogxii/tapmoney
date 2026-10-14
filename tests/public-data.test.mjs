import test from 'node:test';
import assert from 'node:assert/strict';
import { rankingSummary } from '../shared/public-data.mjs';
import { periodGrowth, rankingRows } from '../site/data-utils.js';
import { cachedPublic } from '../server/public-cache.mjs';

test('榜单摘要保留排序、名次变化和三列增长率，不携带其他榜单数据及历史素材', () => {
  const game = { appId:'1', name:'游戏', iconUrl:'https://img-tc.tapimg.com/logo.png', authorIds:['maker'],
    status:'ok',asOf:'2026-10-13',monthStart:'2026-10-01',totalStartDate:'2020-01-01',
    revenue:{yesterday:10,month:130,total:200},media:[{kind:'screenshot',url:'https://img-tc.tapimg.com/shot.png'}],
    history:[...Array.from({length:13},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,'0')}`,revenue:5})),{date:'2026-10-12',revenue:5},{date:'2026-10-13',revenue:10}] };
  const source={schemaVersion:2,asOf:game.asOf,monthStart:game.monthStart,boards:[
    {id:'home',slug:'',name:'群友',games:[game,{...game,appId:'2',revenue:{yesterday:5,month:60,total:300}}],authors:[]},
    {id:'hot',slug:'hot',name:'热门',games:[{...game,name:'其他榜单'}],authors:[{id:'other',name:'另一位'}]}
  ]};
  const summary=rankingSummary(source,'/');
  const legacy=rankingSummary({...source,games:[game],authors:[{id:'legacy'}]},'/');
  assert.ok(!('games' in legacy)&&!('authors' in legacy));
  assert.deepEqual(summary.boards[1].games,[]); assert.deepEqual(summary.boards[1].authors,[]);
  assert.ok(summary.boards[0].games.every(game=>!('history' in game)&&!('media' in game)));
  for(const metric of ['yesterday','month','total']) {
    assert.deepEqual(rankingRows(summary.boards[0].games,metric,summary).map(({game,rank,movement,growth})=>[game.appId,rank,movement,growth]),
      rankingRows(source.boards[0].games,metric,source).map(({game,rank,movement,growth})=>[game.appId,rank,movement,growth]));
    assert.equal(periodGrowth(summary.boards[0].games[0],metric,summary),periodGrowth(game,metric,source));
  }
  assert.equal(rankingSummary(source,'/hot/').boards[1].games[0].name,'其他榜单');
});

test('公开缓存命中不重建数据，ETag 支持 304，手动刷新绕过缓存，错误不缓存', async t => {
  const entries=new Map(); let builds=0,puts=0;
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'caches');
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'caches',descriptor);else delete globalThis.caches;});
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{default:{
    match:async request=>entries.get(request.url)?.clone(),
    put:async(request,response)=>{puts++;entries.set(request.url,response);}
  }}});
  const url='https://tapmoney.example/api/ranking';
  const create=async()=>{builds++;return new Response(JSON.stringify({version:builds}));};
  const first=await cachedPublic(new Request(url),'/api/ranking',create);
  const etag=first.headers.get('ETag'); assert.ok(etag);
  assert.equal((await first.json()).version,1);
  const second=await cachedPublic(new Request(url,{headers:{'If-None-Match':`W/${etag}`}}),'/api/ranking',create);
  assert.equal(second.status,304); assert.equal(await second.text(),''); assert.equal(builds,1);
  const fresh=await cachedPublic(new Request(url,{headers:{'Cache-Control':'no-cache'}}),'/api/ranking',create);
  assert.equal((await fresh.json()).version,2); assert.notEqual(fresh.headers.get('ETag'),etag);
  const error=await cachedPublic(new Request(url),'/api/missing',async()=>new Response('missing',{status:404}));
  assert.equal(error.status,404);assert.equal(puts,2);
});
