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
<script type="application/ld+json">{"@type":"VideoGame","image":"${icon}","author":{"name":"工作室","url":"https://www.taptap.cn/developer/464435"}}</script>
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
    appId: '959305', iconUrl: icon, media: [{kind: 'logo', url: icon}],
    authors: [{ id: 'tap-649821456', name: '好想成为人类啊', avatarUrl: avatar, tapUrl: 'https://www.taptap.cn/user/649821456' }]
  });
  const studioHtml = `<script type="application/ld+json">{"@graph":[{"@type":"VideoGame","image":[{"url":"${icon}"}],"author":{"name":"工作室","url":"/developer/464435"}}]}</script>`;
  assert.equal(extractGameMetadata('959305', studioHtml).authors[0].id, 'studio-464435');
  assert.throws(() => extractGameMetadata('959305', '<html>暂时无法加载</html>'));
});

test('作者可使用 QQ 头像绑定多款游戏，限制头像与主页链接', () => {
  const [author] = normalizeAuthors([{ id: 'maker', name: '作者', qq: '12345678', avatarUrl: avatar, tapUrl: 'https://taptap.cn/user/649821456/?from=other', gameIds: ['959305', 42, '42'] }]);
  assert.equal(author.avatarUrl, avatar);
  assert.equal(normalizeAuthors([{ id: 'qq', name: '作者', qq: '12345678', avatarUrl: '', gameIds: [] }])[0].avatarUrl, 'https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100');
  assert.equal(author.tapUrl, 'https://www.taptap.cn/user/649821456');
  assert.deepEqual(author.gameIds, ['959305', '42']);
  assert.equal(normalizeAuthors([{ id: 'link', name: '作者', avatarUrl: author.avatarUrl, gameIds: [] }])[0].avatarUrl, author.avatarUrl);
  assert.equal(imageUrl('javascript:alert(1)'), null);
  assert.equal(imageUrl('https://name:secret@example.com/image.jpg'), null);
  assert.equal(tapProfileUrl('https://example.com/user/649821456'), null);
  assert.throws(() => normalizeAuthors([{ id: 'bad', name: '作者', qq: 'abc', gameIds: [] }]));
  assert.throws(() => normalizeAuthors([{ id: 'bad', name: '作者', avatarUrl: 'http://example.com/avatar.jpg', gameIds: [] }]));
});

test('配置保存头像留空的意图，编辑 QQ 后不会继续使用旧 QQ 头像', () => {
  const author = { id: 'maker', name: '作者', qq: '12345678', avatarUrl: '', gameIds: [] };
  const saved = normalizeConfig({ games: [], authors: [author] });
  assert.equal(saved.boards[0].authors[0].avatarUrl, null);
  const changed = normalizeAuthors([{ ...saved.boards[0].authors[0], qq: '87654321' }])[0];
  assert.equal(changed.avatarUrl, 'https://q1.qlogo.cn/g?b=qq&nk=87654321&s=100');
  const legacy = normalizeConfig({ games: [], authors: [{ ...author, avatarUrl: 'https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100' }] });
  assert.equal(legacy.boards[0].authors[0].avatarUrl, null);
  assert.equal(normalizeAuthors([{ ...author, qq: '' }])[0].avatarUrl, null);
});

test('作者绑定优先，公开资料采集不携带后台 Cookie，缓存失败沿用历史资料', async t => {
  const cacheFile = await cacheFixture(t);
  const games = [{ appId: '959305' }, { appId: '42' }];
  let requests = 0;
  const options = {
    authors: [{ id: 'maker', name: '作者', qq: '12345678', gameIds: ['959305', '42'] }],
    cacheFile, now: new Date('2026-10-14T03:00:00Z'), wait: async () => {}, mediaCache: async value => value,
    request: async (url, init) => {
      requests++;
      assert.equal(new URL(url).hostname, 'www.taptap.cn');
      assert.ok(!Object.keys(init.headers).some(key => key.toLowerCase() === 'cookie'));
      return new Response(html);
    }
  };
  const catalog = await buildCatalog(games, options);
  assert.equal(requests, 2);
  assert.deepEqual(catalog.games['959305'].authorIds, ['maker']);
  assert.deepEqual(catalog.games['42'].authorIds, ['maker']);
  assert.equal(catalog.games['42'].iconUrl, icon);
  assert.equal(catalog.authors.length, 1);
  assert.ok(!('qq' in catalog.authors[0]));
  assert.ok(!('gameIds' in catalog.authors[0]));
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
    cacheFile, mediaCache: async value => value,
    wait: async ms => { events.push(ms); },
    request: async url => {
      const id = new URL(url).pathname.split('/').at(-1);
      events.push(id);
      return id === '1' ? new Response(html) : new Response('', { status: 429 });
    }
  }), RateLimitError);
  assert.deepEqual(events, ['1', 3000, '2']);
});
