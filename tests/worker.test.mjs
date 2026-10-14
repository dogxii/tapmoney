import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import worker, { tokenHash, publicRanking } from '../server/api.mjs';
import { normalizeConfig } from '../shared/catalog.mjs';

const token = 'local-test-token-with-32-characters-fixture';
const game = { appId: '959305', name: '增量牧场', totalStartDate: '2020-01-01' };
const config = { games: [game], authors: [{ id: 'maker', name: '作者', qq: '12345678', tapUrl: 'https://www.taptap.cn/user/1', gameIds: ['959305'] }] };

async function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const DB = { async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = await Promise.all(statements.map(statement => statement.run())); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }, prepare(sql) {
    const statement = sqlite.prepare(sql);
    const bound = values => ({ first: async () => statement.get(...values), all: async () => ({results:statement.all(...values)}), run: async () => {
      if (values.some(value => typeof value === 'string' && Buffer.byteLength(value) > 2000000)) throw new Error('D1 单值容量超限。');
      return { meta: statement.run(...values) };
    } });
    return { ...bound([]), bind(...values) { return bound(values); } };
  } };
  const env = { DB, ADMIN_TOKEN_HASH: await tokenHash(token), ASSETS: { fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, games: [], authors: [] })) } };
  return { env, sqlite };
}
function request(route, { method = 'GET', body, authorized = true, origin } = {}) {
  return new Request(`https://tapmoney.example${route}`, {
    method, headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

test('更换为短 Token 后，新 Token 可登录，旧 Token 和错误 Token 均失效', async t => {
  const { env } = await fixture(t);
  const newToken = 'short-key';
  env.ADMIN_TOKEN_HASH = await tokenHash(newToken);
  for (const [value, status] of [[newToken, 200], [token, 401], ['wrong-key', 401], ['short key', 401], ['x'.repeat(257), 401]]) {
    const login = new Request('https://tapmoney.example/api/admin/config', { headers: { Authorization: `Bearer ${value}` } });
    assert.equal((await worker.fetch(login, env)).status, status);
  }
});

test('未登录或跨站请求不能读取、修改配置或上传快照', async t => {
  const { env, sqlite } = await fixture(t);
  for (const [route, method] of [['/api/admin/config', 'GET'], ['/api/admin/config', 'PUT'], ['/api/internal/snapshot', 'PUT'], ['/api/admin/collect', 'GET'], ['/api/admin/collect', 'POST']]) {
    const response = await worker.fetch(request(route, { method, authorized: false, body: method === 'PUT' ? config : undefined }), env);
    assert.equal(response.status, 401);
  }
  assert.equal((await worker.fetch(request('/api/admin/config', { method: 'PUT', body: config, origin: 'https://other.example' }), env)).status, 403);
  assert.equal((await worker.fetch(request('/api/admin/collect', { method: 'POST', origin: 'https://other.example' }), env)).status, 403);
  assert.equal(sqlite.prepare('SELECT count(*) as count FROM documents').get().count, 0);
});

test('QQ 头像默认值不会进入编辑字段，公开排行立即反映新的 QQ 号', async t => {
  const { env } = await fixture(t);
  await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { ...config, revision: 0 } }), env);
  const current = await (await worker.fetch(request('/api/admin/config'), env)).json();
  assert.equal(current.boards[0].authors[0].avatarUrl, null);
  const first = publicRanking({ games: [] }, current);
  assert.equal(first.boards[0].authors[0].avatarUrl, 'https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100');
  current.boards[0].authors[0].qq = '87654321';
  const saved = await (await worker.fetch(request('/api/admin/config', { method: 'PUT', body: current }), env)).json();
  assert.equal(publicRanking(first, saved).boards[0].authors[0].avatarUrl, 'https://q1.qlogo.cn/g?b=qq&nk=87654321&s=100');
});

test('手动采集只派发固定仓库的采集工作流，并发和排队中不重复提交', async t => {
  const { env } = await fixture(t);
  env.COLLECT_REPOSITORY = 'owner/tapmoney'; env.COLLECT_TOKEN = 'github-fixture-must-not-leak';
  let dispatched = 0;
  let run = { id: 1, status: 'completed', conclusion: 'success', created_at: new Date(Date.now() - 3600000).toISOString() };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/owner/tapmoney/actions/workflows/collect.yml/'));
    assert.equal(options.headers.Authorization, `Bearer ${env.COLLECT_TOKEN}`);
    assert.equal(options.redirect, 'manual');
    if (options.method === 'POST') {
      dispatched++;
      assert.ok(url.endsWith('/dispatches'));
      assert.deepEqual(JSON.parse(options.body), { ref: 'main' });
      assert.equal(options.headers['Content-Type'], 'application/json');
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ workflow_runs: [run] }));
  });
  const responses = await Promise.all([worker.fetch(request('/api/admin/collect', { method: 'POST' }), env), worker.fetch(request('/api/admin/collect', { method: 'POST' }), env)]);
  assert.equal(dispatched, 1);
  for (const response of responses) { assert.equal(response.status, 202); const data = await response.json(); assert.equal(data.status, 'requested'); assert.ok(!JSON.stringify(data).includes(env.COLLECT_TOKEN)); }
  const pending = await (await worker.fetch(request('/api/admin/collect'), env)).json();
  assert.equal(pending.status, 'requested');
  run = { id: 2, status: 'in_progress', conclusion: null, created_at: new Date().toISOString() };
  const active = await (await worker.fetch(request('/api/admin/collect', { method: 'POST' }), env)).json();
  assert.equal(dispatched, 1); assert.equal(active.runId, 2); assert.equal(active.status, 'in_progress');
  assert.equal(active.url, 'https://github.com/owner/tapmoney/actions/runs/2');
  run.status = 'completed'; run.conclusion = 'failure';
  const failed = await (await worker.fetch(request('/api/admin/collect'), env)).json();
  assert.equal(failed.conclusion, 'failure');
});

test('采集凭证缺失或上游拒绝时明确失败，不假装采集成功或泄露凭证', async t => {
  const { env } = await fixture(t);
  assert.deepEqual(await (await worker.fetch(request('/api/admin/collect'), env)).json(), { enabled: false, status: 'unconfigured' });
  assert.equal((await worker.fetch(request('/api/admin/collect', { method: 'POST' }), env)).status, 503);
  env.COLLECT_REPOSITORY = 'owner/tapmoney'; env.COLLECT_TOKEN = 'github-fixture-must-not-leak';
  t.mock.method(globalThis, 'fetch', async () => new Response(env.COLLECT_TOKEN, { status: 403 }));
  const failed = await worker.fetch(request('/api/admin/collect', { method: 'POST' }), env);
  assert.equal(failed.status, 503);
  const message = await failed.text(); assert.ok(message.includes('Actions')); assert.ok(!message.includes(env.COLLECT_TOKEN));
});

test('GitHub 重定向被拒绝，不转发凭证或派发采集任务', async t => {
  const { env, sqlite } = await fixture(t);
  env.COLLECT_REPOSITORY = 'owner/tapmoney'; env.COLLECT_TOKEN = 'github-fixture-must-not-leak';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://other.example/' } });
  });
  assert.equal((await worker.fetch(request('/api/admin/collect', { method: 'POST' }), env)).status, 503);
  assert.equal(calls, 1);
  assert.equal(sqlite.prepare('SELECT count(*) as count FROM documents').get().count, 0);
});

test('游戏和作者保存到数据库，冲突版本与无效绑定均不覆盖已有配置', async t => {
  const { env } = await fixture(t);
  const first = await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { ...config, revision: 0 } }), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).revision, 1);
  const collision = await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { ...config, revision: 0 } }), env);
  assert.equal(collision.status, 409);
  const invalid = await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { games: [game], authors: [{ id: 'bad', name: '作者', gameIds: ['2'] }], revision: 1 } }), env);
  assert.equal(invalid.status, 400);
  const current = await (await worker.fetch(request('/api/admin/config'), env)).json();
  assert.equal(current.revision, 1);
  assert.equal(current.boards[0].authors[0].qq, '12345678');
  const second = await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { ...current, boards: current.boards.map((board, index) => index ? board : { ...board, games: [{ ...game, name: '更新名称' }] }) } }), env);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).revision, 2);
});

test('公开排行榜即时应用增删、作者绑定，新增游戏与累计日期变化不伪造收益', () => {
  const snapshot = { games: [{ ...game, asOf: '2026-10-13', status: 'ok', revenue: { yesterday: 3, month: 8, total: 20 }, history: [{ date: '2026-10-13', revenue: 3 }] }, { ...game, appId: 'deleted' }], authors: [] };
  const changed = normalizeConfig({ games: [{ ...game, totalStartDate: '2026-10-01' }, { ...game, appId: '2' }], authors: config.authors });
  const publicData = publicRanking(snapshot, changed);
  assert.equal(publicData.boards[0].games.length, 2);
  assert.equal(publicData.boards[0].games[0].revenue.total, null);
  assert.deepEqual(publicData.boards[0].games[0].history, []);
  assert.deepEqual(publicData.boards[0].games[0].authorIds, ['maker']);
  assert.equal(publicData.boards[0].games[1].status, 'pending');
  assert.equal(publicData.boards[0].games[1].revenue.yesterday, null);
  assert.ok(!('qq' in publicData.boards[0].authors[0]));
  assert.ok(!('gameIds' in publicData.boards[0].authors[0]));
});

test('云端快照仅保存公开收益字段，访客无需 Token 即可读取', async t => {
  const { env, sqlite } = await fixture(t);
  await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { ...config, revision: 0 } }), env);
  const local = `/media/${'a'.repeat(64)}.png`;
  const snapshot = {
    schemaVersion: 1, generatedAt: '2026-10-14T03:00:00Z', asOf: '2026-10-13', monthStart: '2026-10-01', cookie: 'must-not-leak',
    games: [{ ...game, iconUrl: local, iconSourceUrl: 'https://img-tc.tapimg.com/logo.png', media: [{kind:'logo',url:local},{kind:'screenshot',url:'javascript:bad'}], queryDeveloperId: 'secret-studio', status: 'ok', asOf: '2026-10-13', monthStart: '2026-10-01', updatedAt: '2026-10-14T03:00:00Z', revenue: { yesterday: 3, month: 3, total: 3 }, history: [{ date: '2026-10-13', revenue: 3, cookie: 'must-not-leak' }] }], authors: [{id:'maker',name:'作者',avatarUrl:local,avatarSourceUrl:'https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100'}]
  };
  // 真实查询工作室 ID 本身为数字；快照不会保存该配置字段。
  snapshot.games[0].queryDeveloperId = '275960';
  assert.equal((await worker.fetch(request('/api/internal/snapshot', { method: 'PUT', body: snapshot }), env)).status, 200);
  const saved = sqlite.prepare("SELECT body FROM documents WHERE key = 'snapshot'").get().body;
  assert.ok(!saved.includes('must-not-leak'));
  assert.ok(!saved.includes('275960'));
  const response = await worker.fetch(request('/api/ranking', { authorized: false }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60, must-revalidate');
  const data = await response.json();
  assert.deepEqual(data.boards[0].games[0].history, [{ date: '2026-10-13', revenue: 3 }]);
  assert.equal(data.boards[0].games[0].iconUrl, local);
  assert.deepEqual(data.boards[0].games[0].media,[{kind:'logo',url:local}]);
  assert.equal(data.boards[0].authors[0].avatarUrl,local);
});

test('旧 D1 文档无需重置即可读取为多榜配置，旧快照只属于首页', async t => {
  const {env,sqlite} = await fixture(t);
  sqlite.prepare('INSERT INTO documents (key,body,revision,updated_at) VALUES (?,?,?,?)').run('config',JSON.stringify(config),7,'2026-10-14');
  const migrated = await (await worker.fetch(request('/api/admin/config'),env)).json();
  assert.equal(migrated.revision,7);
  assert.deepEqual(migrated.boards.map(b=>[b.slug,b.games.length,b.authors.length]),[['',1,1],['hot',0,0]]);
  const publicData = await (await worker.fetch(request('/api/ranking',{authorized:false}),env)).json();
  assert.equal(publicData.schemaVersion,2);
  assert.equal(publicData.boards[0].games.length,1);
  assert.deepEqual(publicData.boards[1].games,[]);
});

test('多榜快照上传清理各榜私有字段，删除热门榜游戏不影响群友榜，过期版本不能覆盖', async t => {
  const { env, sqlite } = await fixture(t);
  const home = {id:'home',name:'群友榜',slug:'',...config};
  const hot = {...home,id:'hot',slug:'hot',name:'热门榜',authors:[{...config.authors[0],name:'热门作者',qq:'87654321'}]};
  let saved = await (await worker.fetch(request('/api/admin/config',{method:'PUT',body:{boards:[home,hot],revision:0}}),env)).json();
  const snapshot = {schemaVersion:2,generatedAt:'2026-10-14T03:00:00Z',asOf:'2026-10-13',monthStart:'2026-10-01',boards:[home,hot].map(b=>({...b,private:'must-not-leak',games:[{...game,queryDeveloperId:'275960',status:'ok',asOf:'2026-10-13',monthStart:'2026-10-01',updatedAt:'2026-10-14T03:00:00Z',revenue:{yesterday:3,month:8,total:20},history:[]}]}))};
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env)).status,200);
  const body = sqlite.prepare("SELECT body FROM documents WHERE key = 'snapshot'").get().body;
  for (const key of ['must-not-leak','queryDeveloperId','qq','gameIds']) assert.ok(!body.includes(key));
  const before = await (await worker.fetch(request('/api/ranking',{authorized:false}),env)).json();
  assert.equal(before.boards[0].authors[0].name,'作者');
  assert.equal(before.boards[1].authors[0].name,'热门作者');
  const stale = structuredClone(saved);
  saved.boards[1].games=[]; saved.boards[1].authors=[];
  assert.equal((await worker.fetch(request('/api/admin/config',{method:'PUT',body:saved}),env)).status,200);
  assert.equal((await worker.fetch(request('/api/admin/config',{method:'PUT',body:stale}),env)).status,409);
  const after = await (await worker.fetch(request('/api/ranking',{authorized:false}),env)).json();
  assert.deepEqual(after.boards[0],before.boards[0]);
  assert.deepEqual(after.boards[1].games,[]); assert.deepEqual(after.boards[1].authors,[]);
  const invalid = {...snapshot,boards:[snapshot.boards[0],{...snapshot.boards[1],slug:''}]};
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:invalid}),env)).status,400);
});

test('5000 款游戏的大快照分片保存，失败回滚，缩小快照清理旧分片且不影响另一榜', async t => {
  const {env,sqlite}=await fixture(t);
  const games=Array.from({length:5000},(_,i)=>({...game,appId:String(i+1),name:`游戏 ${i} 🎮 ${'测试'.repeat(8)}`}));
  const config={boards:[{id:'home',name:'群友榜',slug:'',games:[],authors:[]},{id:'hot',name:'热门榜',slug:'hot',games,authors:[]}]};
  assert.ok(Buffer.byteLength(JSON.stringify(config)) > 256 * 1024);
  assert.equal((await worker.fetch(request('/api/admin/config',{method:'PUT',body:{...config,revision:0}}),env)).status,200);
  const at='2026-10-14T03:00:00.000Z';
  const snapshot={schemaVersion:2,generatedAt:at,asOf:'2026-10-13',monthStart:'2026-10-01',boards:config.boards.map(b=>({...b,
    games:b.games.map((g,i)=>({...g,authorIds:[`maker-${i}`],authorMode:'auto',status:i===0?'unavailable':'pending',...(i===0?{lastAttemptAt:at}:{}),revenue:{yesterday:null,month:null,total:null},history:Array.from({length:31},(_,day)=>({date:`2026-09-${String(day%30+1).padStart(2,'0')}`,revenue:day+0.5}))})),
    authors:b.games.map((g,i)=>({id:`maker-${i}`,name:`作者 ${i}`}))
  }))};
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 2000000);
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env)).status,200);
  const stored=sqlite.prepare("SELECT body FROM documents WHERE key='snapshot'").get();
  assert.equal(JSON.parse(stored.body).format,'chunked-json-v1');
  for(const {body} of sqlite.prepare("SELECT body FROM documents WHERE key LIKE 'snapshot:%'").all()) assert.ok(Buffer.byteLength(body)<2000000);
  const saved=await (await worker.fetch(request('/api/ranking'),env)).json();
  assert.equal(saved.boards[1].games.length,5000);
  assert.equal(saved.boards[1].authors.length,5000);
  assert.equal(saved.boards[1].games.at(-1).name,games.at(-1).name);
  assert.deepEqual(saved.boards[1].games.at(-1).history,snapshot.boards[1].games.at(-1).history);
  assert.equal(saved.boards[1].games[0].lastAttemptAt,at);
  assert.equal(saved.boards[1].games[1].status,'pending');
  assert.equal(saved.boards[1].games[1].revenue.total,null);
  sqlite.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON documents WHEN NEW.key='snapshot:1' BEGIN SELECT RAISE(ABORT,'模拟分片写入失败'); END");
  const failed={...snapshot,generatedAt:'2026-10-14T04:00:00.000Z'};
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:failed}),env)).status,400);
  assert.deepEqual(await (await worker.fetch(request('/api/ranking'),env)).json(),saved);
  sqlite.exec('DROP TRIGGER fail_snapshot');
  const smaller={...snapshot,boards:snapshot.boards.map(b=>({...b,games:[],authors:[]}))};
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:smaller}),env)).status,200);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM documents WHERE key LIKE 'snapshot:%'").get().count,0);
  const reduced=await (await worker.fetch(request('/api/ranking'),env)).json();
  assert.equal(reduced.boards[1].games[0].revenue.total,null);
  assert.deepEqual(reduced.boards[0],saved.boards[0]);
});

test('公开摘要和游戏详情独立加载，摘要缓存不重读完整快照，配置和快照变化均使摘要失效', async t => {
  const {env,sqlite}=await fixture(t);
  await worker.fetch(request('/api/admin/config',{method:'PUT',body:{...config,revision:0}}),env);
  const snapshot={schemaVersion:1,generatedAt:'2026-10-14T03:00:00Z',asOf:'2026-10-13',monthStart:'2026-10-01',
    games:[{...game,status:'ok',asOf:'2026-10-13',monthStart:'2026-10-01',revenue:{yesterday:3,month:3,total:3},history:[{date:'2026-10-13',revenue:3}]}],authors:[]};
  await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env);
  const route='/api/ranking?view=summary&path=%2F';
  const first=await worker.fetch(request(route,{authorized:false}),env);
  const data=await first.json();assert.equal(data.summary,true);assert.ok(!('history' in data.boards[0].games[0]));
  assert.deepEqual(data.boards[1].games,[]);
  let reads=0;
  const prepare=env.DB.prepare;
  env.DB.prepare=sql=>{reads++;return prepare(sql);};
  assert.deepEqual(await (await worker.fetch(request(route),env)).json(),data);
  assert.equal(reads,1);
  const current=await (await worker.fetch(request('/api/admin/config'),env)).json();current.boards[0].games[0].name='修改名称';
  await worker.fetch(request('/api/admin/config',{method:'PUT',body:current}),env);
  const updated=await (await worker.fetch(request(route),env)).json();
  assert.equal(updated.boards[0].games[0].name,'修改名称');
  snapshot.games[0].revenue.total=9;
  await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env);
  assert.equal((await (await worker.fetch(request(route),env)).json()).boards[0].games[0].revenue.total,9);
  const detail=await (await worker.fetch(request(`/api/game?board=home&id=${game.appId}`,{authorized:false}),env)).json();
  assert.deepEqual(detail.game.history,snapshot.games[0].history);
  assert.equal((await worker.fetch(request('/api/game?board=hot&id=123'),env)).status,404);
  assert.equal((await worker.fetch(request('/api/ranking?view=summary&path=%2Fmissing'),env)).status,404);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM documents WHERE key='public:summary:/missing'").get().count,0);
  assert.equal((await worker.fetch(request(route,{method:'HEAD'}),env)).status,200);
  const privateResponse=await worker.fetch(request('/api/admin/config'),env);
  assert.equal(privateResponse.headers.get('Cache-Control'),'no-store');
});
