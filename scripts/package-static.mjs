import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { build } from './build.mjs';
import { ROOT, atomicWrite, isMain, printError, readJson } from './lib.mjs';

const DEFAULT_SOURCE = 'https://tapmoney.pages.dev/data/ranking.json';

function dateStamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSqlite(file, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', [file], { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`sqlite3 失败：${error.trim()}`)));
    child.stdin.end(sql);
  });
}

function parseArgs(argv) {
  const options = { source: DEFAULT_SOURCE, output: path.join(ROOT, 'output', `tapmoney-static-${dateStamp()}`), board: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--source') options.source = argv[++index];
    else if (arg === '--output') options.output = path.resolve(argv[++index]);
    else if (arg === '--local') options.source = path.join(ROOT, 'site/data/ranking.json');
    else if (arg === '--board') options.board = argv[++index];
    else if (arg === '--help') {
      console.log('用法：node scripts/package-static.mjs [--local] [--source URL|文件] [--board ID] [--output 目录]');
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!options.source) throw new Error('数据源不能为空。');
  return options;
}

function selectBoard(snapshot, config, boardId) {
  if (!boardId) return { snapshot, config, redirectFrom: null };
  const board = snapshot.boards.find(item => item.id === boardId);
  if (!board) throw new Error(`找不到榜单：${boardId}`);
  // 单榜静态包把目标榜的原子路径改成首页，保留稳定的榜单 ID 和全部详情数据。
  const selected = { ...board, slug: '' };
  const redirectFrom = board.slug ? `/${board.slug}` : null;
  const configured = (config.boards ?? []).find(item => item.id === boardId);
  const selectedConfig = configured ? { ...configured, slug: '' } : {
    id: selected.id, name: selected.name, slug: '',
    games: selected.games.map(({ appId, name, iconUrl, totalStartDate }) => ({ appId, name, iconUrl, totalStartDate })), authors: []
  };
  return { snapshot: { ...snapshot, boards: [selected] }, config: { ...config, boards: [selectedConfig] }, redirectFrom };
}

async function readSource(source) {
  if (/^https:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`数据源请求失败（HTTP ${response.status}）。`);
    return { buffer: Buffer.from(await response.arrayBuffer()), source };
  }
  const file = path.resolve(source);
  return { buffer: await readFile(file), source: file };
}

async function writeSql({ output, snapshot, config, updatedAt }) {
  const sqlFile = path.join(output, 'backup', 'tapmoney.sql');
  const sqliteFile = path.join(output, 'backup', 'tapmoney.sqlite');
  const snapshotBody = JSON.stringify(snapshot);
  const configBody = JSON.stringify(config);
  const sql = [
    '-- TapMoney static snapshot exported to a portable SQLite documents table.',
    'PRAGMA foreign_keys = OFF;',
    'BEGIN;',
    'CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);',
    'DELETE FROM documents;',
    `INSERT INTO documents (key, body, revision, updated_at) VALUES ('config', ${sqlText(configBody)}, 1, ${sqlText(updatedAt)});`,
    `INSERT INTO documents (key, body, revision, updated_at) VALUES ('snapshot', ${sqlText(snapshotBody)}, 1, ${sqlText(updatedAt)});`,
    'COMMIT;',
    ''
  ].join('\n');
  await writeFile(sqlFile, sql);
  await rm(sqliteFile, { force: true });
  await runSqlite(sqliteFile, sql);
  return { sqlFile, sqliteFile };
}

export async function packageStatic({ source = DEFAULT_SOURCE, output = path.join(ROOT, 'output', `tapmoney-static-${dateStamp()}`), board = null } = {}) {
  const loaded = await readSource(source);
  const text = loaded.buffer.toString('utf8');
  let sourceSnapshot;
  try { sourceSnapshot = JSON.parse(text); } catch { throw new Error('数据源不是有效 JSON。'); }
  if (sourceSnapshot.schemaVersion !== 2 || !Array.isArray(sourceSnapshot.boards)) throw new Error('数据源不是 TapMoney schemaVersion 2 快照。');
  const sourceConfig = await readJson(path.join(ROOT, 'config/boards.json'), { boards: sourceSnapshot.boards.map(({ id, name, slug, games }) => ({ id, name, slug, games, authors: [] })) });
  const selected = selectBoard(sourceSnapshot, sourceConfig, board);
  const snapshot = selected.snapshot;
  const config = selected.config;
  const updatedAt = snapshot.generatedAt || new Date().toISOString();
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await build({ snapshot, directory: output });
  await rm(path.join(output, '.DS_Store'), { force: true });
  if (selected.redirectFrom) await writeFile(path.join(output, '_redirects'), `${selected.redirectFrom} / 301\n`);
  await mkdir(path.join(output, 'backup'), { recursive: true });
  await writeFile(path.join(output, 'backup', 'ranking.json'), `${JSON.stringify(snapshot)}\n`);
  await writeFile(path.join(output, 'backup', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const sql = await writeSql({ output, snapshot, config, updatedAt });
  const manifest = {
    format: 'tapmoney-static-package-v1',
    source: loaded.source,
    sourceSha256: sha256(loaded.buffer),
    boardFilter: board,
    redirectFrom: selected.redirectFrom,
    generatedAt: new Date().toISOString(),
    snapshotGeneratedAt: snapshot.generatedAt ?? null,
    asOf: snapshot.asOf ?? null,
    boards: snapshot.boards.map(board => ({ id: board.id, slug: board.slug, name: board.name, games: board.games.length, authors: board.authors.length })),
    files: { json: 'backup/ranking.json', sql: 'backup/tapmoney.sql', sqlite: 'backup/tapmoney.sqlite', html: 'index.html' }
  };
  await atomicWrite(path.join(output, 'backup', 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await atomicWrite(path.join(output, 'PACKAGE-README.txt'), [
    'TapMoney 静态数据包',
    '',
    '直接将此目录作为静态站点根目录即可部署。页面使用 data/ 下的 JSON，不依赖 /api 接口。',
    `backup/ranking.json 是${board ? `“${snapshot.boards[0].name}”单榜快照` : '线上快照'}；backup/tapmoney.sql 和 backup/tapmoney.sqlite 是便携式 SQLite 备份。`,
    ...(selected.redirectFrom ? [`旧路径 ${selected.redirectFrom} 会重定向到首页。`] : []),
    `数据源：${loaded.source}`,
    `快照时间：${snapshot.generatedAt ?? '未知'}`,
    `源文件 SHA-256：${manifest.sourceSha256}`,
    ''
  ].join('\n'));
  return { output, manifest, ...sql };
}

if (isMain(import.meta.url)) {
  packageStatic(parseArgs(process.argv.slice(2))).then(result => {
    console.log(`静态包已生成：${result.output}`);
    console.log(`源数据 SHA-256：${result.manifest.sourceSha256}`);
  }).catch(printError);
}
