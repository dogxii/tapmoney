import path from 'node:path';
import { mkdir, rmdir } from 'node:fs/promises';
import { ROOT, loadEnv, printError } from './lib.mjs';
import { collect } from './collect.mjs';
import { deploy } from './deploy.mjs';
import { uploadSnapshot } from './sync.mjs';
import { configSource } from '../shared/config.mjs';

const lock = path.join(ROOT, '.local/daily.lock');
await mkdir(path.dirname(lock), { recursive: true });
try {
  await mkdir(lock);
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('已有每日任务运行中；若上次进程被强制终止，请删除 .local/daily.lock 后重试。');
    process.exit(1);
  }
  throw error;
}
try {
  const env = await loadEnv();
  const collectOnly = process.argv.includes('--collect-only');
  if (!collectOnly && !env.CLOUDFLARE_PAGES_PROJECT) throw new Error('每日采集并发布需要 CLOUDFLARE_PAGES_PROJECT；仅本地采集可加 --collect-only。');
  console.log(`[${new Date().toISOString()}] 开始每日更新。`);
  await collect({ env });
  if (!collectOnly) {
    if (configSource(env) === 'cloud') await uploadSnapshot(env);
    await deploy(env);
  }
  console.log('每日更新完成。');
} catch (error) { printError(error); }
finally { await rmdir(lock); }
