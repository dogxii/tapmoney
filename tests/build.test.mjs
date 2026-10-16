import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build, DEFAULT_PUBLIC_DATA_URL } from '../scripts/build.mjs';

test('构建始终生成纯静态站点并使用公开 jsDelivr 快照', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tapmoney-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await build({ directory, env: { TAPTAP_COOKIE: 'must-not-leak' } });
  const runtime = await readFile(path.join(directory, 'runtime.js'), 'utf8');
  assert.ok(runtime.includes(DEFAULT_PUBLIC_DATA_URL));
  assert.ok(!runtime.includes('adminEnabled'));
  assert.ok(!runtime.includes('must-not-leak'));
  await assert.rejects(access(path.join(directory, '_worker.js')));
  await assert.rejects(access(path.join(directory, '_routes.json')));
  await assert.rejects(access(path.join(directory, 'admin.js')));
  await assert.rejects(access(path.join(directory, '.env.local')));
  await assert.rejects(access(path.join(directory, '404.html')));
  await assert.rejects(access(path.join(directory, '.DS_Store')));
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  assert.match(html, /src="\/assets\/app-[A-Z0-9]+\.js"/);
  for (const [, file] of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) await access(path.join(directory, file));
  const scripts = (await Promise.all((await readdir(path.join(directory, 'assets'))).filter(file => file.endsWith('.js')).map(file => readFile(path.join(directory, 'assets', file), 'utf8')))).join('\n');
  assert.ok(!scripts.includes('/api/') && !scripts.includes('must-not-leak'));
  assert.ok((await readFile(path.join(directory, 'shared/boards.mjs'), 'utf8')).includes('boardAtPath'));
  const summary = JSON.parse(await readFile(path.join(directory, 'data/boards/index.json'), 'utf8'));
  assert.equal(summary.summary, true);
  assert.ok(summary.boards.filter(board => board.slug).every(board => !board.games.length));
  assert.ok(summary.boards.flatMap(board => board.games).every(game => !('history' in game) && !('media' in game)));
});

test('自定义公开 JSON 镜像只接受无凭证的 HTTPS', async () => {
  for (const url of ['http://example.com/ranking.json', 'https://user:password@example.com/ranking.json']) {
    await assert.rejects(build({ env: { TAPMONEY_DATA_URL: url } }));
  }
});
