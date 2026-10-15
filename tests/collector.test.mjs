import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { periods, revenueTotal, TapTapClient, AuthenticationError, RateLimitError } from '../scripts/lib.mjs';
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

test('连续收益请求默认至少相隔三秒，429 不重试', async t => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const times = [];
  const client = new TapTapClient({ TAPTAP_COOKIE: 'fixture' }, {
    wait: async ms => { now += ms; },
    request: async () => {
      times.push(now);
      return times.length === 3 ? new Response('', { status: 429, headers: { 'Retry-After': '120' } }) :
        new Response(JSON.stringify({ success: true, data: { id: '1' } }));
    }
  });
  await client.get('/api/user/v1/me');
  await client.get('/api/user/v1/me');
  await assert.rejects(() => client.get('/api/user/v1/me'), RateLimitError);
  assert.deepEqual(times, [10000, 13000, 16000]);
});

test('并发请求共用启动间隔，429 后不再发送排队请求', async t => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const waits = [], times = [];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const client = new TapTapClient({ TAPTAP_COOKIE: 'fixture' }, {
    wait: ms => new Promise(resolve => waits.push({ ms, release: () => { now += ms; resolve(); } })),
    request: async () => {
      times.push(now);
      return times.length === 2 ? new Response('', { status: 429 }) : new Response(JSON.stringify({ success: true, data: {} }));
    }
  });
  const done = Promise.allSettled(Array.from({ length: 3 }, () => client.get('/api/user/v1/me')));
  await tick(); assert.equal(waits[0].ms, 0); waits[0].release();
  await tick(); assert.deepEqual(times, [10000]); assert.equal(waits[1].ms, 3000); waits[1].release();
  await tick(); if (waits[2]) waits[2].release();
  const results = await done;
  assert.deepEqual(times, [10000, 13000]);
  assert.equal(results[0].status, 'fulfilled');
  assert.ok(results.slice(1).every(result => result.reason instanceof RateLimitError));
});

async function fixture(t) {
  // 预期的采集失败不写入测试进程的日志管道。
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const directory = await mkdtemp(path.join(tmpdir(), 'tapmoney-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'ranking.json');
}
const env = { TAPTAP_COOKIE: 'fixture-secret', TAPTAP_DEVELOPER_ID: '275960' };
const game = { appId: '959305', name: '增量牧场', totalStartDate: '2020-01-01' };

test('并发采集限制在途数量、保持配置顺序，单个失败不会覆盖该游戏历史', async t => {
  const outputFile = await fixture(t);
  const games = Array.from({length:7}, (_,i)=>({...game,appId:String(i+1)}));
  await writeFile(outputFile, JSON.stringify({games:[{...games[2],updatedAt:'2026-10-12T03:00:00Z',asOf:'2026-10-11',monthStart:'2026-10-01',revenue:{yesterday:8,month:9,total:10}}]}));
  let active = 0, peak = 0;
  const snapshot = await collect({ env:{...env,TAPMONEY_CONCURRENCY:'3'}, config:{games,authors:[]}, outputFile, now:new Date('2026-10-14T03:00:00Z'),
    catalogBuilder:async()=>({games:{},authors:[]}),client:{get:async()=>({}),revenue:async(dev,app)=>{
      active++; peak=Math.max(peak,active);
      await new Promise(resolve=>setImmediate(resolve)); active--;
      if(app==='3')throw new Error('模拟单款失败');
      return Number(app);
    }}
  });
  assert.equal(peak,3); assert.equal(active,0);
  assert.deepEqual(snapshot.boards[0].games.map(game=>game.appId),games.map(game=>game.appId));
  assert.deepEqual(snapshot.boards[0].games.map(game=>game.revenue.total),[1,2,10,4,5,6,7]);
  assert.equal(snapshot.boards[0].games[2].asOf,'2026-10-11');
});

test('限定游戏集合时只请求新增游戏，旧榜数据保持原样', async t => {
  const outputFile = await fixture(t);
  const games = [1, 2, 3].map(id => ({ ...game, appId: String(id) }));
  await writeFile(outputFile, JSON.stringify({ games: [{ ...games[0], status: 'ok', asOf: '2026-10-14', updatedAt: '2026-10-15T00:00:00Z', revenue: { yesterday: 9, month: 10, total: 11 }, history: [] }, ...games.slice(1).map(item => ({ ...item, status: 'pending', revenue: { yesterday: null, month: null, total: null }, history: [] }))] }));
  const requested = [];
  const snapshot = await collect({ env, onlyGameIds: new Set(['2']), config: { games, authors: [] }, outputFile, now: new Date('2026-10-15T03:00:00Z'), catalogBuilder: async () => ({ games: {}, authors: [] }), client: { get: async () => ({}), revenue: async (developerId, appId) => { requested.push(appId); return 2; }, report: async (developerId, appId) => ({ total: 2, history: [] }) } });
  assert.deepEqual(requested, ['2', '2']);
  assert.equal(snapshot.boards[0].games[0].revenue.total, 11);
  assert.equal(snapshot.boards[0].games[0].asOf, '2026-10-14');
  assert.equal(snapshot.boards[0].games[1].status, 'ok');
});

test('并发发生限流时等待在途任务退出、不派发后续游戏、不写入部分快照', async t => {
  const outputFile=await fixture(t), previous=JSON.stringify({games:[]});
  await writeFile(outputFile,previous);
  let release, settled=false;
  const gate=new Promise(resolve=>{release=resolve;}), started=new Set();
  const collecting=collect({env:{...env,TAPMONEY_CONCURRENCY:'2'},outputFile,
    config:{games:[1,2,3,4].map(id=>({...game,appId:String(id)})),authors:[]},
    catalogBuilder:async()=>({games:{},authors:[]}),client:{get:async()=>({}),revenue:async(dev,app)=>{
      started.add(app);
      if(app==='1')throw new RateLimitError();
      await gate; return 1;
    }}
  });
  collecting.then(()=>{settled=true;},()=>{settled=true;});
  while(!started.size) await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false); assert.deepEqual([...started],['1','2']);
  release(); await assert.rejects(collecting,RateLimitError);
  assert.deepEqual([...started],['1','2']); assert.equal(await readFile(outputFile,'utf8'),previous);
});

test('月初不请求反向日期区间，公开快照不包含凭证或查询工作室', async t => {
  const outputFile = await fixture(t);
  const calls = [];
  const catalog = {
    games: { '959305': { iconUrl: 'https://example.com/game.png', authorIds: ['maker'] } },
    authors: [{ id: 'maker', name: '作者', avatarUrl: 'https://example.com/avatar.png', tapUrl: 'https://www.taptap.cn/user/1', extra: 'must-not-leak' }]
  };
  const snapshot = await collect({ catalogBuilder: async () => catalog, env, config: {games: [game], authors: []}, now: new Date('2026-10-31T16:05:00Z'), outputFile, client: {
    get: async () => ({}), revenue: async (...args) => { calls.push(args); return 10; }
  } });
  assert.equal(calls.length, 2);
  assert.equal(snapshot.boards[0].games[0].revenue.month, 0);
  assert.equal(snapshot.monthStart, '2026-11-01');
  assert.equal(snapshot.boards[0].games[0].iconUrl, 'https://example.com/game.png');
  assert.deepEqual(snapshot.boards[0].games[0].authorIds, ['maker']);
  assert.equal(snapshot.boards[0].authors[0].name, '作者');
  const written = await readFile(outputFile, 'utf8');
  assert.ok(!written.includes('fixture-secret'));
  assert.ok(!written.includes('275960'));
  assert.ok(!written.includes('must-not-leak'));
});

test('部分失败保留日期和历史收益，新游戏失败保持 null', async t => {
  const outputFile = await fixture(t);
  await writeFile(outputFile, JSON.stringify({ games: [{ ...game, updatedAt: '2026-10-12T03:00:00Z', asOf: '2026-10-11', monthStart: '2026-10-01', revenue: { yesterday: 8, month: 50, total: 90 }, cookie: 'must-not-leak' }] }));
  const snapshot = await collect({ catalogBuilder: async () => ({ games: {}, authors: [] }), env, config: { games: [game, { ...game, appId: '2' }, { ...game, appId: '3' }], authors: [] }, now: new Date('2026-10-14T03:00:00Z'), outputFile, client: {
    get: async () => ({}), revenue: async (dev, appId) => { if (appId !== '2') throw new Error('upstream failure'); return 2; }
  } });
  assert.equal(snapshot.boards[0].games[0].status, 'stale');
  assert.equal(snapshot.boards[0].games[0].asOf, '2026-10-11');
  assert.equal(snapshot.boards[0].games[0].revenue.total, 90);
  assert.equal(snapshot.boards[0].games[2].status, 'unavailable');
  assert.equal(snapshot.boards[0].games[2].revenue.total, null);
  assert.ok(!(await readFile(outputFile, 'utf8')).includes('must-not-leak'));
});

test('认证中途失效时不覆盖上次快照', async t => {
  const outputFile = await fixture(t);
  const previous = JSON.stringify({ games: [] });
  await writeFile(outputFile, previous);
  await assert.rejects(() => collect({ catalogBuilder: async () => ({ games: {}, authors: [] }), env, config: { games: [game], authors: [] }, outputFile, client: { get: async () => ({}), revenue: async () => { throw new AuthenticationError(); } } }), AuthenticationError);
  assert.equal(await readFile(outputFile, 'utf8'), previous);
});

test('分批续采只请求本批游戏，保留未处理游戏，完成后不再请求 TapTap', async t => {
  const outputFile = await fixture(t);
  const config = { games: Array.from({length:5}, (_,i)=>({...game,appId:String(i+1)})), authors: [] };
  const calls = [], catalogs = [];
  const options = { env: {...env,TAPMONEY_BATCH_SIZE:'2'}, config, outputFile,
    catalogBuilder: async games => { catalogs.push(games.map(g=>g.appId)); return {games:{},authors:[]}; },
    client: { get: async () => { calls.push('auth'); }, revenue: async (dev,app) => { calls.push(app); return Number(app); } }
  };
  const first=await collect({...options,now:new Date('2026-10-14T03:00:00Z')});
  assert.deepEqual(first.boards[0].games.map(g=>g.status),['ok','ok','pending','pending','pending']);
  const second=await collect({...options,now:new Date('2026-10-14T04:00:00Z')});
  assert.deepEqual(second.boards[0].games[0],first.boards[0].games[0]);
  assert.equal(second.boards[0].games[4].revenue.total,null);
  await collect({...options,now:new Date('2026-10-14T05:00:00Z')});
  const before=calls.length;
  const finished=await collect({...options,now:new Date('2026-10-14T06:00:00Z')});
  assert.ok(finished.boards[0].games.every(g=>g.status==='ok'));
  assert.equal(calls.length,before);
  assert.deepEqual(catalogs,[['1','2'],['3','4'],['5']]);
  assert.equal(calls.filter(c=>c==='auth').length,3);
  const forced=await collect({...options,force:true,now:new Date('2026-10-14T07:00:00Z')});
  assert.equal(forced.boards[0].games[0].updatedAt,'2026-10-14T07:00:00.000Z');
});

test('失败批次记录尝试时间并让出队列，次日重试，历史金额和日期不变', async t => {
  const outputFile = await fixture(t);
  const config={games:[game,{...game,appId:'2'}],authors:[]};
  const saved={...game,status:'ok',asOf:'2026-10-12',monthStart:'2026-10-01',updatedAt:'2026-10-13T03:00:00Z',revenue:{yesterday:7,month:8,total:9},history:[{date:'2026-10-12',revenue:7}]};
  await writeFile(outputFile,JSON.stringify({games:[saved],authors:[]}));
  const calls=[];
  const options={env:{...env,TAPMONEY_BATCH_SIZE:'1'},config,outputFile,
    catalogBuilder:async()=>({games:{},authors:[]}),
    client:{get:async()=>({}),revenue:async(dev,app)=>{calls.push(app);throw new Error('无数值记录');}}
  };
  const first=await collect({...options,now:new Date('2026-10-14T03:00:00Z')});
  assert.equal(calls[0],'2'); // 未采集过的游戏优先。
  assert.equal(first.boards[0].games[1].status,'unavailable');
  assert.equal(first.boards[0].games[0].status,'stale');
  const second=await collect({...options,now:new Date('2026-10-14T04:00:00Z')});
  assert.deepEqual(calls,['2',game.appId]);
  assert.deepEqual(second.boards[0].games[0].revenue,saved.revenue);
  assert.equal(second.boards[0].games[0].asOf,saved.asOf);
  await collect({...options,now:new Date('2026-10-14T05:00:00Z')});
  assert.equal(calls.length,2);
  await collect({...options,now:new Date('2026-10-15T03:00:00Z')});
  assert.equal(calls.at(-1),'2');
});

test('部分采集成功后遇限流也停止后续游戏，完整保留上次快照', async t => {
  const outputFile = await fixture(t);
  const previous = JSON.stringify({ games: [] });
  await writeFile(outputFile, previous);
  const called = [];
  await assert.rejects(() => collect({
    env, outputFile, config: { games: [game, { ...game, appId: '2' }, { ...game, appId: '3' }], authors: [] },
    catalogBuilder: async () => ({ games: {}, authors: [] }),
    client: { get: async () => ({}), revenue: async (dev, app) => {
      called.push(app);
      if (app === '2') throw new RateLimitError();
      return 1;
    } }
  }), RateLimitError);
  assert.ok(called.includes(game.appId));
  assert.ok(!called.includes('3'));
  assert.equal(await readFile(outputFile, 'utf8'), previous);
});

test('多榜采集仅复用相同工作室、游戏和日期的报表，官方制作人跨榜一致，累计区间保持独立', async t => {
  const outputFile = await fixture(t);
  const author = name => ({ id: 'maker', name, gameIds: [game.appId] });
  const config = { boards: [
    { id: 'home', slug: '', name: '群友榜', games: [game], authors: [author('群友')] },
    { id: 'hot', slug: 'hot', name: '热门榜', games: [game], authors: [author('热门')] },
    { id: 'other', slug: 'other', name: '其他榜', games: [{ ...game, totalStartDate: '2026-10-01' }], authors: [] },
    { id: 'studio', slug: 'studio', name: '其他工作室', games: [{ ...game, queryDeveloperId: '123' }], authors: [] }
  ] };
  const calls = [];
  const snapshot = await collect({ env, config, outputFile, now: new Date('2026-10-14T03:00:00Z'), catalogBuilder: async () => {
    return { games: { [game.appId]: { name:'官方名称', iconUrl:'https://example.com/logo.png', authorIds:['tap-1'], authorMode:'auto' } }, authors:[{id:'tap-1',name:'官方作者',tapUrl:'https://www.taptap.cn/user/1'}] };
  }, client: {
    get: async () => ({}),
    revenue: async (...args) => { calls.push(['revenue', ...args]); return 1; },
    report: async (...args) => { calls.push(['report', ...args]); return { total: args[2] === '2020-01-01' ? 20 : 8, history: [] }; }
  } });
  assert.equal(calls.length, 7); // 同工作室共 2 个期间收益 + 2 个累计区间；另一工作室 3 次。
  assert.deepEqual(snapshot.boards.map(b=>b.games[0].revenue.total), [20,20,8,20]);
  assert.equal(snapshot.boards[0].authors[0].name, '官方作者');
  assert.equal(snapshot.boards[1].authors[0].name, '官方作者');
  assert.ok(!JSON.stringify(snapshot).includes('gameIds'));
  assert.ok(!JSON.stringify(snapshot).includes('queryDeveloperId'));
});

test('同游戏跨榜采集失败时，各榜只保留自己的历史和日期，不从其他榜复制数据', async t => {
  const outputFile = await fixture(t);
  const config = { boards: [
    { id: 'home', slug: '', name: '群友榜', games: [game], authors: [] },
    { id: 'hot', slug: 'hot', name: '热门榜', games: [game, { ...game, appId: '2' }], authors: [] }
  ] };
  const saved = (value, date) => ({ ...game, updatedAt: date+'T03:00:00Z', asOf: date, monthStart: '2026-10-01', revenue: { yesterday: value, month: value, total: value }, history: [{date, revenue:value}] });
  await writeFile(outputFile, JSON.stringify({ schemaVersion: 2, boards: config.boards.map((b,i)=>({...b,games:[saved(i+1,`2026-10-${10+i}`)]})) }));
  const snapshot = await collect({ env, config, outputFile, now: new Date('2026-10-14T03:00:00Z'), catalogBuilder: async () => ({games:{},authors:[]}), client: {
    get: async () => ({}), revenue: async (dev, app) => { if(app === game.appId) throw new Error('upstream'); return 0; }
  } });
  assert.equal(snapshot.boards[0].games[0].revenue.total, 1);
  assert.equal(snapshot.boards[0].games[0].asOf, '2026-10-10');
  assert.equal(snapshot.boards[1].games[0].revenue.total, 2);
  assert.equal(snapshot.boards[1].games[0].asOf, '2026-10-11');
  assert.deepEqual(snapshot.boards[1].games[0].history, [{date:'2026-10-11',revenue:2}]);
});
