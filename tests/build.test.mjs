import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../scripts/build.mjs';
import { configSource } from '../shared/config.mjs';

test('旧管理凭证不自动启用云模式，配置来源必须明确', () => {
  assert.equal(configSource({ TAPMONEY_API_URL: 'https://example.com', TAPMONEY_ADMIN_TOKEN: 'fixture' }), 'repository');
  assert.equal(configSource({ TAPMONEY_CONFIG_SOURCE: 'cloud' }), 'cloud');
  assert.throws(() => configSource({ TAPMONEY_CONFIG_SOURCE: 'unknown' }));
});

test('默认构建不包含服务器和管理代码，凭证不会进入运行配置', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tapmoney-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await build({ directory, env: { TAPTAP_COOKIE: 'must-not-leak', TAPMONEY_ADMIN_TOKEN: 'must-not-leak' } });
  const runtime = await readFile(path.join(directory, 'runtime.js'), 'utf8');
  assert.ok(runtime.includes('./data/ranking.json'));
  assert.ok(runtime.includes('adminEnabled = false'));
  assert.ok(!runtime.includes('must-not-leak'));
  await assert.rejects(access(path.join(directory, '_worker.js')));
  await assert.rejects(access(path.join(directory, 'admin.js')));
  await assert.rejects(access(path.join(directory, '.env.local')));
});

test('公开镜像仅限无凭证的 HTTPS，在线管理不能读取另一份镜像', async () => {
  for (const url of ['http://example.com/ranking.json', 'https://user:password@example.com/ranking.json']) {
    await assert.rejects(build({ env: { TAPMONEY_DATA_URL: url } }));
  }
  await assert.rejects(build({ env: { TAPMONEY_CONFIG_SOURCE: 'cloud', TAPMONEY_DATA_URL: 'https://example.com/ranking.json' } }));
});

test('在线管理构建只运行 API 路由，不引入 Node 运行时依赖或凭证', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tapmoney-cloud-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await build({ directory, env: { TAPMONEY_CONFIG_SOURCE: 'cloud', TAPMONEY_ADMIN_TOKEN: 'must-not-leak' } });
  const worker = await readFile(path.join(directory, '_worker.js'), 'utf8');
  const routes = JSON.parse(await readFile(path.join(directory, '_routes.json'), 'utf8'));
  assert.ok(!worker.includes('node:'));
  assert.ok(!worker.includes('must-not-leak'));
  assert.deepEqual(routes.include, ['/api/*']);
  assert.ok((await readFile(path.join(directory, 'runtime.js'), 'utf8')).includes('adminEnabled = true'));
});
