import path from 'node:path';
import { cp, rm } from 'node:fs/promises';
import { ROOT, loadEnv, atomicWrite, isMain, printError } from './lib.mjs';
import { configSource } from '../shared/config.mjs';
import { wrangler } from './cloud.mjs';

export async function build({ env, directory = path.join(ROOT, 'dist') } = {}) {
  env ??= await loadEnv();
  const adminEnabled = configSource(env) === 'cloud';
  const rankingUrl = env.TAPMONEY_DATA_URL || (adminEnabled ? './api/ranking' : './data/ranking.json');
  if (env.TAPMONEY_DATA_URL) {
    const url = new URL(rankingUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('TAPMONEY_DATA_URL 必须是公开 HTTPS 地址。');
    if (adminEnabled) throw new Error('在线管理模式使用同源 API，不能同时配置 TAPMONEY_DATA_URL。');
  }
  await rm(directory, { recursive: true, force: true });
  await cp(path.join(ROOT, 'site'), directory, { recursive: true });
  await atomicWrite(path.join(directory, 'runtime.js'), `export const rankingUrl = ${JSON.stringify(rankingUrl)};\nexport const adminEnabled = ${adminEnabled};\n`);
  if (adminEnabled) {
    await wrangler(['pages', 'functions', 'build', path.join(ROOT, 'server/functions'), '--outdir', path.join(directory, '_worker.js'), '--output-routes-path', path.join(directory, '_routes.json'), '--compatibility-date', '2026-10-14'], { env });
  } else {
    await rm(path.join(directory, 'admin.js'));
  }
  console.log(`已构建 Pages ${adminEnabled ? '在线管理' : '静态'}站点。`);
  return directory;
}

if (isMain(import.meta.url)) build().catch(printError);
