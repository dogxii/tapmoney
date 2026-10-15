import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCatalog, extractGameMetadata, normalizeAuthors, imageUrl, tapProfileUrl } from '../scripts/catalog.mjs';
import { normalizeConfig } from '../shared/catalog.mjs';
import { RateLimitError } from '../scripts/lib.mjs';

const icon = 'https://img-tc.tapimg.com/market/images/game.png/_tap_appicon.jpg';
const avatar = 'https://img3-tc.tapimg.com/avatars/author.png/_tap_avatar.jpg';
const html = `
<script type="application/ld+json">{"@type":"VideoGame","name":"官方名称","image":"${icon}","author":{"name":"工作室","url":"https://www.taptap.cn/developer/464435"}}</script>
<a class="unrelated" href="/user/111111"><span>其他游戏作者</span></a>
<a href="/user/649821456" class="developer-people-list__person">
  <img class="developer-people-list__avatar" data-src="${avatar}" src="data:image/png;base64,placeholder">
  <div class="developer-people-list__person-name">好想成为人类啊</div>
</a>`;

async function cacheFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tapmoney-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'metadata.json');
}

test('公开页解析真实 Logo 和制作人，忽略其他普通用户链接', () => {
  assert.deepEqual(extractGameMetadata('959305', html), {
    appId: '959305', name: '官方名称', iconUrl: icon, media: [{kind: 'logo', url: icon}],
    authors: [{ id: 'tap-649821456', name: '好想成为人类啊', avatarUrl: avatar, tapUrl: 'https://www.taptap.cn/user/649821456' }]
  });
  const studioHtml = `<script type="application/ld+json">{"@graph":[{"@type":"VideoGame","image":[{"url":"${icon}"}],"author":{"name":"工作室","url":"/developer/464435"}}]}</script>`;
  assert.equal(extractGameMetadata('959305', studioHtml).authors[0].id, 'studio-464435');
  assert.throws(() => extractGameMetadata('959305', '<html>暂时无法加载</html>'));
});

test('官方资料验证 HTTPS 链接，并丢弃旧配置的 QQ 与手动绑定', () => {
  const [author] = normalizeAuthors([{ id:'tap-1', name:'作者', qq:'12345678', gameIds:['42'], avatarUrl:avatar, tapUrl:'https://taptap.cn/user/1/?from=other' }]);
  assert.equal(author.avatarUrl, avatar);
  assert.equal(author.tapUrl, 'https://www.taptap.cn/user/1');
  assert.ok(!('qq' in author)); assert.ok(!('gameIds' in author));
  assert.deepEqual(normalizeConfig({games:[],authors:[author]}).boards[0].authors, []);
  assert.equal(imageUrl('javascript:alert(1)'), null);
  assert.equal(imageUrl('https://name:secret@example.com/image.jpg'), null);
  assert.equal(tapProfileUrl('https://example.com/user/1'), null);
  assert.throws(() => normalizeAuthors([{id:'bad',name:'作者',avatarUrl:'http://example.com/avatar.jpg'}]));
});

test('官方名称和制作人覆盖手动资料，缓存一周，刷新失败沿用历史资料', async t => {
  const cacheFile = await cacheFixture(t);
  const games = [{ appId: '959305' }, { appId: '42' }];
  let requests = 0;
  const options = {
    authors: [{ id: 'maker', name: '作者', qq: '12345678', gameIds: ['959305', '42'] }],
    cacheFile, now: new Date('2026-10-14T03:00:00Z'), wait: async () => {},
    request: async (url, init) => {
      requests++;
      assert.equal(new URL(url).hostname, 'www.taptap.cn');
      assert.ok(!Object.keys(init.headers).some(key => key.toLowerCase() === 'cookie'));
      return new Response(html);
    }
  };
  const catalog = await buildCatalog(games, options);
  assert.equal(requests, 2);
  assert.deepEqual(catalog.games['959305'].authorIds, ['tap-649821456']);
  assert.deepEqual(catalog.games['42'].authorIds, ['tap-649821456']);
  assert.equal(catalog.games['42'].iconUrl, icon);
  assert.equal(catalog.authors[0].avatarUrl, avatar);
  assert.equal(catalog.authors.length, 1);
  assert.ok(!('qq' in catalog.authors[0]));
  assert.ok(!('gameIds' in catalog.authors[0]));
  assert.equal(catalog.games['42'].name, '官方名称');
  const saved = await readFile(cacheFile, 'utf8');
  await buildCatalog(games, { ...options, request: async () => { assert.fail('七天内应使用缓存'); } });
  const fallback = await buildCatalog(games, { ...options, authors: [], now: new Date('2026-10-22T03:00:00Z'), request: async () => { throw new Error('network'); } });
  assert.equal(await readFile(cacheFile, 'utf8'), saved);
  assert.equal(fallback.games['959305'].iconUrl, icon);
  assert.deepEqual(fallback.games['959305'].authorIds, ['tap-649821456']);
});

test('资料页按三秒间隔串行请求，429 后不访问后续游戏', async t => {
  const cacheFile = await cacheFixture(t);
  const events = [];
  await assert.rejects(() => buildCatalog([{ appId: '1' }, { appId: '2' }, { appId: '3' }], {
    cacheFile,
    wait: async ms => { events.push(ms); },
    request: async url => {
      const id = new URL(url).pathname.split('/').at(-1);
      events.push(id);
      return id === '1' ? new Response(html) : new Response('', { status: 429 });
    }
  }), RateLimitError);
  assert.equal(events[0], '1'); assert.ok(events[1] > 2900 && events[1] <= 3000); assert.equal(events[2], '2');
  assert.equal(events.length, 3);
  assert.ok(JSON.parse(await readFile(cacheFile, 'utf8'))['1'], '限流前已成功的资料应落盘');
});

test('JSON-LD 用户与制作人使用相同 ID，工作室与用户 ID 分开，厂商头像可解析', () => {
  const base = `<script type="application/ld+json">{"@type":"VideoGame","name":"游戏","author":{"name":"作者","url":"/user/42"}}</script>`;
  assert.equal(extractGameMetadata('1',base).authors[0].id,'tap-42');
  const studio = base + `<a class="developer-people-list__person" href="/developer/42"><div class="developer-people-list__avatar"><img class="tap-image" src="${avatar}"></div><div class="developer-people-list__person-name">工作室</div></a>`;
  assert.equal(extractGameMetadata('1',studio).authors[0].id,'studio-42');
  assert.equal(extractGameMetadata('1',studio).authors[0].avatarUrl,avatar);
});

test('全新 runner 可从公开快照复用一周资料，同游戏跨榜不再请求资料页', async t => {
  const cacheFile = await cacheFixture(t);
  const fetchedAt='2026-10-14T03:00:00Z';
  const seed={'42':{...extractGameMetadata('42',html),fetchedAt}};
  const result=await buildCatalog([{appId:'42',name:'配置旧名称',iconUrl:'https://example.com/old.png'}],{cacheFile,seed,now:new Date('2026-10-15T03:00:00Z'),request:async()=>{assert.fail('一周内不应重新抓取');}});
  assert.equal(result.games['42'].name,'官方名称'); assert.equal(result.games['42'].iconUrl,icon); assert.equal(result.authors[0].metadataUpdatedAt,fetchedAt);
  const refreshed=await buildCatalog([{appId:'42'}],{cacheFile,seed,now:new Date('2026-10-22T03:00:00Z'),request:async()=>new Response(html.replaceAll('好想成为人类啊','新昵称').replace('官方名称','新名称'))});
  assert.equal(refreshed.games['42'].name,'新名称');assert.equal(refreshed.authors[0].name,'新昵称');
});
