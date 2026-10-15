import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import worker, { tokenHash, publicRanking } from '../server/api.mjs';
import { normalizeConfig } from '../shared/catalog.mjs';
import { snapshotTransfer } from '../shared/snapshot-transfer.mjs';
import { rankingSummary } from '../shared/public-data.mjs';

const token = 'local-test-token-with-32-characters-fixture';
const game = { appId: '959305', name: '增量牧场', totalStartDate: '2020-01-01' };
const config = { games: [game], authors: [{ id: 'maker', name: '作者', qq: '12345678', tapUrl: 'https://www.taptap.cn/user/1', gameIds: ['959305'] }] };

async function fixture(t) {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.ok(String(url).startsWith('https://www.taptap.cn/app/'), '测试不应访问真实网络');
    return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'VideoGame',name:game.name})+'</script>');
  });
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  // RPC 除了 JSON 本身还有字符串编码和参数开销，按保守值检查聚合大小。
  const checkRpc = value => assert.ok(JSON.stringify(value).length * 4 <= 32 * 1024 * 1024, 'D1 单次 RPC 容量超限。');
  const DB = { async batch(statements) {
    checkRpc(statements.map(statement => statement.parameters));
    sqlite.exec('BEGIN');
    try { const results = await Promise.all(statements.map(statement => statement.run())); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }, prepare(sql) {
    const statement = sqlite.prepare(sql);
    const bound = values => {
      if (/\b(?:GLOB|LIKE)\b/.test(sql) && values.some(value => typeof value === 'string' && value.length > 50)) throw new Error('D1 LIKE/GLOB 模式超长。');
      return { parameters: values, first: async () => statement.get(...values), all: async () => {
      const results = statement.all(...values); checkRpc(results); return {results};
    }, run: async () => {
      if (values.some(value => typeof value === 'string' && Buffer.byteLength(value) > 2000000)) throw new Error('D1 单值容量超限。');
      return { meta: statement.run(...values) };
    } };
    };
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

test('旧 QQ 与手动作者配置被迁移移除，已有游戏资料不能手动修改', async t => {
  const {env} = await fixture(t);
  const first = await (await worker.fetch(request('/api/admin/config',{method:'PUT',body:{...config,revision:0}}),env)).json();
  assert.deepEqual(first.boards[0].authors, []);
  first.boards[0].games[0].name = '手动名称'; first.boards[0].games[0].iconUrl='https://example.com/custom.png';
  const saved = await (await worker.fetch(request('/api/admin/config',{method:'PUT',body:first}),env)).json();
  assert.equal(saved.boards[0].games[0].name, game.name);
  assert.ok(!saved.boards[0].games[0].iconUrl);
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

test('游戏保存到数据库，冲突版本与无效 ID 不覆盖已有配置', async t => {
  const { env } = await fixture(t);
  const first = await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { ...config, revision: 0 } }), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).revision, 1);
  const collision = await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { ...config, revision: 0 } }), env);
  assert.equal(collision.status, 409);
  const invalid = await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { games: [{...game,appId:'invalid'}], authors: [], revision: 1 } }), env);
  assert.equal(invalid.status, 400);
  const current = await (await worker.fetch(request('/api/admin/config'), env)).json();
  assert.equal(current.revision, 1);
  assert.deepEqual(current.boards[0].authors, []);
  const second = await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { ...current, boards: current.boards.map((board, index) => index ? board : { ...board, games: [{ ...game, name: '更新名称' }] }) } }), env);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).revision, 2);
});

test('公开排行榜即时应用增删，旧手动作者失效，新增游戏与累计日期变化不伪造收益', () => {
  const snapshot = { games: [{ ...game, asOf: '2026-10-13', status: 'ok', revenue: { yesterday: 3, month: 8, total: 20 }, history: [{ date: '2026-10-13', revenue: 3 }] }, { ...game, appId: 'deleted' }], authors: [] };
  const changed = normalizeConfig({ games: [{ ...game, totalStartDate: '2026-10-01' }, { ...game, appId: '2' }], authors: config.authors });
  const publicData = publicRanking(snapshot, changed);
  assert.equal(publicData.boards[0].games.length, 2);
  assert.equal(publicData.boards[0].games[0].revenue.total, null);
  assert.deepEqual(publicData.boards[0].games[0].history, []);
  assert.deepEqual(publicData.boards[0].games[0].authorIds, []);
  assert.equal(publicData.boards[0].games[1].status, 'pending');
  assert.equal(publicData.boards[0].games[1].revenue.yesterday, null);
  assert.deepEqual(publicData.boards[0].authors, []);
});

test('云端快照仅保存公开收益字段，访客无需 Token 即可读取', async t => {
  const { env, sqlite } = await fixture(t);
  await worker.fetch(request('/api/admin/config', { method: 'PUT', body: { ...config, revision: 0 } }), env);
  const local = `/media/${'a'.repeat(64)}.png`;
  const snapshot = {
    schemaVersion: 1, generatedAt: '2026-10-14T03:00:00Z', asOf: '2026-10-13', monthStart: '2026-10-01', cookie: 'must-not-leak',
    games: [{ ...game, authorIds:['tap-1'], iconUrl: local, iconSourceUrl: 'https://img-tc.tapimg.com/logo.png', media: [{kind:'logo',url:local},{kind:'screenshot',url:'javascript:bad'}], queryDeveloperId: 'secret-studio', status: 'ok', asOf: '2026-10-13', monthStart: '2026-10-01', updatedAt: '2026-10-14T03:00:00Z', revenue: { yesterday: 3, month: 3, total: 3 }, history: [{ date: '2026-10-13', revenue: 3, cookie: 'must-not-leak' }] }], authors: [{id:'tap-1',name:'作者',tapUrl:'https://www.taptap.cn/user/1',avatarUrl:local}]
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
  assert.deepEqual(migrated.boards.map(b=>[b.slug,b.games.length,b.authors.length]),[['',1,0],['hot',0,0]]);
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
  const snapshot = {schemaVersion:2,generatedAt:'2026-10-14T03:00:00Z',asOf:'2026-10-13',monthStart:'2026-10-01',boards:[home,hot].map(b=>({...b,authors:[{id:'tap-1',name:'官方作者',tapUrl:'https://www.taptap.cn/user/1'}],private:'must-not-leak',games:[{...game,authorIds:['tap-1'],queryDeveloperId:'275960',status:'ok',asOf:'2026-10-13',monthStart:'2026-10-01',updatedAt:'2026-10-14T03:00:00Z',revenue:{yesterday:3,month:8,total:20},history:[]}]}))};
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env)).status,200);
  const body = sqlite.prepare("SELECT body FROM documents WHERE key = 'snapshot'").get().body;
  for (const key of ['must-not-leak','queryDeveloperId','qq','gameIds']) assert.ok(!body.includes(key));
  const before = await (await worker.fetch(request('/api/ranking',{authorized:false}),env)).json();
  assert.equal(before.boards[0].authors[0].name,'官方作者');
  assert.equal(before.boards[1].authors[0].name,'官方作者');
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

test('5000 款游戏的大快照分批读写，上传失败保留旧版，并发读取不混版，过期分片清理', async t => {
  const {env,sqlite}=await fixture(t);
  const games=Array.from({length:5000},(_,i)=>({...game,appId:String(i+1),name:`游戏 ${i} 🎮 ${'测试'.repeat(8)}`}));
  const config={boards:[{id:'home',name:'群友榜',slug:'',games:[],authors:[]},{id:'hot',name:'热门榜',slug:'hot',games,authors:[]}]};
  assert.ok(Buffer.byteLength(JSON.stringify(config)) > 256 * 1024);
  sqlite.prepare('INSERT INTO documents (key,body,revision,updated_at) VALUES (?,?,?,?)').run('config',JSON.stringify(config),1,'2026-10-14');
  const at='2026-10-14T03:00:00.000Z';
  const snapshot={schemaVersion:2,generatedAt:at,asOf:'2026-10-13',monthStart:'2026-10-01',boards:config.boards.map(b=>({...b,
    games:b.games.map((g,i)=>({...g,authorIds:[`tap-${i+1}`],authorMode:'auto',status:i===0?'unavailable':'pending',...(i===0?{lastAttemptAt:at}:{}),revenue:{yesterday:null,month:null,total:null},history:Array.from({length:31},(_,day)=>({date:`2026-09-${String(day%30+1).padStart(2,'0')}`,revenue:day+0.5}))})),
    authors:b.games.map((g,i)=>({id:`tap-${i+1}`,name:`作者 ${i}`,tapUrl:`https://www.taptap.cn/user/${i+1}`}))
  }))};
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 2000000);
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env)).status,200);
  const stored=sqlite.prepare("SELECT body FROM documents WHERE key='snapshot'").get();
  const manifest=JSON.parse(stored.body);
  assert.equal(manifest.format,'chunked-json-v2');
  assert.ok(manifest.parts>4);
  for(const {body} of sqlite.prepare('SELECT body FROM documents WHERE key GLOB ?').all(`${manifest.prefix}:*`)) assert.ok(Buffer.byteLength(body)<2000000);
  const partCount=()=>sqlite.prepare("SELECT count(*) AS count FROM documents WHERE key GLOB 'parts:snapshot:*'").get().count;
  const saved=await (await worker.fetch(request('/api/ranking'),env)).json();
  assert.equal(saved.boards[1].games.length,5000);
  assert.equal(saved.boards[1].authors.length,5000);
  assert.equal(saved.boards[1].games.at(-1).name,games.at(-1).name);
  assert.deepEqual(saved.boards[1].games.at(-1).history,snapshot.boards[1].games.at(-1).history);
  assert.equal(saved.boards[1].games[0].lastAttemptAt,at);
  assert.equal(saved.boards[1].games[1].status,'pending');
  assert.equal(saved.boards[1].games[1].revenue.total,null);
  // 第二批失败：第一批已暂存的数据也应清理，主文档不能变化。
  sqlite.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON documents WHEN NEW.key GLOB 'parts:snapshot:*:4' BEGIN SELECT RAISE(ABORT,'模拟分片写入失败'); END");
  const failed={...snapshot,generatedAt:'2026-10-14T04:00:00.000Z'};
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:failed}),env)).status,400);
  assert.deepEqual(await (await worker.fetch(request('/api/ranking'),env)).json(),saved);
  assert.equal(partCount(),manifest.parts);
  sqlite.exec('DROP TRIGGER fail_snapshot');
  // 暂存完成后的最后切换事务失败，同样保留旧版并清理未发布的新版本。
  sqlite.exec("CREATE TRIGGER fail_snapshot BEFORE UPDATE ON documents WHEN NEW.key='snapshot' BEGIN SELECT RAISE(ABORT,'模拟版本切换失败'); END");
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:failed}),env)).status,400);
  assert.deepEqual(await (await worker.fetch(request('/api/ranking'),env)).json(),saved);
  assert.equal(partCount(),manifest.parts);
  sqlite.exec('DROP TRIGGER fail_snapshot');
  const smaller={...snapshot,boards:snapshot.boards.map(b=>({...b,games:[],authors:[]}))};
  const prepare=env.DB.prepare;
  let switched=false;
  env.DB.prepare=sql=>{
    const statement=prepare(sql);
    if(!sql.startsWith('SELECT key, body FROM documents WHERE key IN')) return statement;
    return {...statement,bind(...values){
      const bound=statement.bind(...values);
      return {...bound,async all(){
        const result=await bound.all();
        if(!switched){
          switched=true;
          assert.equal(values.length,4);
          assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:smaller}),env)).status,200);
        }
        return result;
      }};
    }};
  };
  // 读取第一批后切换新快照，后续批次仍应读到旧版。
  assert.deepEqual(await (await worker.fetch(request('/api/ranking'),env)).json(),saved);
  assert.ok(switched);
  env.DB.prepare=prepare;
  assert.equal(partCount(),manifest.parts);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM documents WHERE key LIKE 'snapshot:%'").get().count,0);
  const reduced=await (await worker.fetch(request('/api/ranking'),env)).json();
  assert.equal(reduced.boards[1].games[0].revenue.total,null);
  assert.deepEqual(reduced.boards[0],saved.boards[0]);
  sqlite.prepare("UPDATE documents SET updated_at='2020-01-01T00:00:00.000Z' WHERE key GLOB 'parts:snapshot:*'").run();
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:smaller}),env)).status,200);
  assert.equal(partCount(),0);
});

test('旧版事务分片快照保持兼容，缩小文档时清除旧分片', async t => {
  const {env,sqlite}=await fixture(t);
  const snapshot={schemaVersion:2,generatedAt:'2026-10-14T03:00:00Z',asOf:'2026-10-13',monthStart:'2026-10-01',boards:[{id:'home',slug:'',name:'群友榜',authors:[],games:
    Array.from({length:1000},(_,i)=>({...game,appId:String(i+1),status:'ok',history:Array.from({length:20},(_,day)=>({date:`2026-10-${String(day%13+1).padStart(2,'0')}`,revenue:day})),revenue:{yesterday:1,month:2,total:3}}))
  }]};
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env)).status,200);
  assert.equal(JSON.parse(sqlite.prepare("SELECT body FROM documents WHERE key='snapshot'").get().body).format,'chunked-json-v1');
  const saved=await (await worker.fetch(request('/api/ranking'),env)).json();
  assert.equal(saved.boards[0].games.length,1000);
  assert.deepEqual(saved.boards[0].games.at(-1).history,snapshot.boards[0].games.at(-1).history);
  const smaller={...snapshot,boards:[{...snapshot.boards[0],games:[]}]};
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:smaller}),env)).status,200);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM documents WHERE key LIKE 'snapshot:%'").get().count,0);
  assert.equal((await (await worker.fetch(request('/api/ranking'),env)).json()).boards[0].games.length,0);
});

test('小批上传只在完整校验后发布，失败可续传，跨片重复身份被拒绝，已发布分片不能修改', async t => {
  const {env,sqlite}=await fixture(t);
  const original={schemaVersion:1,generatedAt:'2026-10-14T03:00:00Z',asOf:'2026-10-13',monthStart:'2026-10-01',games:[],authors:[]};
  assert.equal((await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:original}),env)).status,200);
  const before=await (await worker.fetch(request('/api/ranking'),env)).json();
  const author={id:'tap-1',name:'作者',tapUrl:'https://www.taptap.cn/user/1',qq:'123456',secret:'must-not-leak'};
  const snapshot={...original,boards:[{id:'home',slug:'',name:'群友榜',authors:[author],games:[{...game,authorIds:[author.id],status:'ok',asOf:original.asOf,monthStart:original.monthStart,secret:'must-not-leak',queryDeveloperId:'123',revenue:{yesterday:1,month:2,total:3},history:[{date:'2026-10-12',revenue:0.5},{date:original.asOf,revenue:1}]}]}]};
  const {metadata,parts}=snapshotTransfer(snapshot,1);
  assert.equal(parts.length,2);
  const start=await worker.fetch(request('/api/internal/snapshot/upload',{method:'POST',body:metadata,authorized:false}),env);
  assert.equal(start.status,401);
  const begin=async metadata=>{
    const response=await worker.fetch(request('/api/internal/snapshot/upload',{method:'POST',body:metadata}),env);
    assert.equal(response.status,200);
    return '/api/internal/snapshot/upload/'+(await response.json()).uploadId;
  };
  const base=await begin(metadata);
  const staleBase=await begin(metadata);
  const put=async (base,part)=>worker.fetch(request(`${base}?board=${part.board}&part=${part.part}`,{method:'PUT',body:part.body}),env);
  assert.equal((await put(base,parts[0])).status,200);
  assert.equal((await worker.fetch(request(base,{method:'POST',body:{}}),env)).status,409);
  assert.deepEqual(await (await worker.fetch(request('/api/ranking'),env)).json(),before);
  assert.equal((await put(base,parts[1])).status,200);
  // 分片请求可安全重试，不能产生多份记录。
  assert.equal((await put(base,parts[1])).status,200);
  sqlite.exec("CREATE TRIGGER fail_snapshot BEFORE UPDATE ON documents WHEN NEW.key='snapshot' BEGIN SELECT RAISE(ABORT,'模拟发布失败'); END");
  assert.equal((await worker.fetch(request(base,{method:'POST',body:{}}),env)).status,400);
  assert.deepEqual(await (await worker.fetch(request('/api/ranking'),env)).json(),before);
  sqlite.exec('DROP TRIGGER fail_snapshot');
  assert.equal((await worker.fetch(request(base,{method:'POST',body:{}}),env)).status,200);
  const saved=await (await worker.fetch(request('/api/ranking'),env)).json();
  assert.equal(saved.boards[0].games[0].revenue.total,3);
  assert.deepEqual(saved.boards[0].games[0].history,snapshot.boards[0].games[0].history);
  assert.ok(!JSON.stringify(saved).includes('must-not-leak'));
  assert.ok(!('qq' in saved.boards[0].authors[0]));
  const summary=await (await worker.fetch(request('/api/ranking?view=summary&path=%2F'),env)).json();
  assert.deepEqual(summary,rankingSummary(saved,'/'));
  assert.equal(summary.boards[0].games[0].growth.yesterday,100);
  const detail=await (await worker.fetch(request('/api/game?board=home&id='+game.appId),env)).json();
  assert.deepEqual(detail.game.history,saved.boards[0].games[0].history);
  const authorDetail=await (await worker.fetch(request('/api/author?board=home&id=tap-1'),env)).json();
  assert.equal(authorDetail.author.history.length,2);
  assert.equal((await put(base,parts[0])).status,409);
  for(const part of parts) assert.equal((await put(staleBase,part)).status,200);
  assert.equal((await worker.fetch(request(staleBase,{method:'POST',body:{}}),env)).status,409);
  assert.deepEqual(await (await worker.fetch(request('/api/ranking'),env)).json(),saved);
  const duplicate={...snapshot,boards:[{...snapshot.boards[0],games:[...snapshot.boards[0].games,...snapshot.boards[0].games]}]};
  const transfer=snapshotTransfer(duplicate,1), duplicateBase=await begin(transfer.metadata);
  for(const part of transfer.parts) assert.equal((await put(duplicateBase,part)).status,200);
  assert.equal((await worker.fetch(request(duplicateBase,{method:'POST',body:{}}),env)).status,400);
  assert.deepEqual(await (await worker.fetch(request('/api/ranking'),env)).json(),saved);
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
  const current=await (await worker.fetch(request('/api/admin/config'),env)).json();current.boards[0].name='修改榜名';
  await worker.fetch(request('/api/admin/config',{method:'PUT',body:current}),env);
  const updated=await (await worker.fetch(request(route),env)).json();
  assert.equal(updated.boards[0].name,'修改榜名');
  snapshot.games[0].revenue.total=9;
  await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env);
  assert.equal((await (await worker.fetch(request(route),env)).json()).boards[0].games[0].revenue.total,9);
  const detail=await (await worker.fetch(request(`/api/game?board=home&id=${game.appId}`,{authorized:false}),env)).json();
  assert.deepEqual(detail.game.history,snapshot.games[0].history);
  assert.equal((await worker.fetch(request('/api/game?board=hot&id=123'),env)).status,404);
  assert.equal((await worker.fetch(request('/api/ranking?view=summary&path=%2Fmissing'),env)).status,404);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM documents WHERE key='public:summary:authors-v1:/missing'").get().count,0);
  assert.equal((await worker.fetch(request(route,{method:'HEAD'}),env)).status,200);
  const privateResponse=await worker.fetch(request('/api/admin/config'),env);
  assert.equal(privateResponse.headers.get('Cache-Control'),'no-store');
});

test('添加只采用官方游戏资料，预览缓存跨榜复用，已有游戏起始区间不被另一榜覆盖', async t => {
  const {env} = await fixture(t);
  let calls=0;
  t.mock.method(globalThis,'fetch',async (url,init) => {
    calls++;assert.ok(!init.headers.Cookie);
    return new Response('<script type="application/ld+json">{"@type":"VideoGame","name":"官方游戏","image":"https://img.tapimg.com/logo.png"}</script>');
  });
  for(let i=0;i<2;i++) assert.equal((await worker.fetch(request('/api/admin/game?id=42'),env)).status,200);
  assert.equal(calls,1);
  const config={boards:[{id:'home',slug:'',name:'群友',games:[{...game,appId:'42',name:'伪造名称',iconUrl:'https://example.com/fake.png'}],authors:[]},{id:'hot',slug:'hot',name:'热门',games:[],authors:[]}]};
  let saved = await (await worker.fetch(request('/api/admin/config',{method:'PUT',body:{...config,revision:0}}),env)).json();
  assert.equal(calls,1); assert.equal(saved.boards[0].games[0].name,'官方游戏');assert.equal(saved.boards[0].games[0].iconUrl,'https://img.tapimg.com/logo.png');
  saved.boards[1].games=[{...saved.boards[0].games[0],name:'另一个名称'}];
  saved=await (await worker.fetch(request('/api/admin/config',{method:'PUT',body:saved}),env)).json();
  assert.equal(calls,1); assert.equal(saved.boards[1].games[0].name,'官方游戏');
});

test('公开作者详情按需读取，复用投影缓存，缺失作者不创建缓存记录', async t => {
  const {env,sqlite}=await fixture(t);
  await worker.fetch(request('/api/admin/config',{method:'PUT',body:{...config,revision:0}}),env);
  const at='2026-10-14T03:00:00Z';
  const snapshot={schemaVersion:1,generatedAt:at,asOf:'2026-10-13',monthStart:'2026-10-01',
    games:[{...game,metadataUpdatedAt:at,authorIds:['tap-1'],status:'ok',asOf:'2026-10-13',monthStart:'2026-10-01',revenue:{yesterday:3,month:3,total:3},history:[{date:'2026-10-13',revenue:3}]}],
    authors:[{id:'tap-1',name:'官方作者',tapUrl:'https://www.taptap.cn/user/1'}]};
  await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env);
  const route='/api/author?board=home&id=tap-1';
  const response=await worker.fetch(request(route,{authorized:false}),env);
  assert.equal(response.status,200);assert.ok(response.headers.get('ETag'));assert.ok(response.headers.get('Cache-Control').includes('max-age=60'));
  const data=await response.json(); assert.equal(data.author.revenue.total,3);assert.equal(data.author.gameCount,1);assert.equal(data.games.length,1);assert.ok(!('history' in data.games[0]));
  let reads=0;const prepare=env.DB.prepare;env.DB.prepare=sql=>{reads++;return prepare(sql);};
  assert.deepEqual(await (await worker.fetch(request(route),env)).json(),data);assert.equal(reads,1);
  assert.equal((await worker.fetch(request('/api/author?board=hot&id=tap-1'),env)).status,404);
  assert.equal((await worker.fetch(request('/api/author?board=home&id=bad'),env)).status,400);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM documents WHERE key='public:author:hot:tap-1'").get().count,0);
  snapshot.games[0].revenue.total=9;
  await worker.fetch(request('/api/internal/snapshot',{method:'PUT',body:snapshot}),env);
  assert.equal((await (await worker.fetch(request(route),env)).json()).author.revenue.total,9);
});
