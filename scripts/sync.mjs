import path from 'node:path';
import { ROOT, loadEnv, readJson, atomicWrite, isMain, printError } from './lib.mjs';
import { normalizeConfig } from '../shared/catalog.mjs';
import { loadConfig } from './config.mjs';
import { snapshotTransfer } from '../shared/snapshot-transfer.mjs';

export async function adminRequest(route, { env, method = 'GET', body } = {}) {
  env ??= await loadEnv();
  if (!env.TAPMONEY_API_URL || !env.TAPMONEY_ADMIN_TOKEN) throw new Error('尚未配置云端管理服务。');
  const base = new URL(env.TAPMONEY_API_URL);
  if (base.protocol !== 'https:') throw new Error('管理服务必须使用 HTTPS。');
  let response;
  try {
    response = await fetch(new URL(route, base), {
      method, headers: { Authorization: `Bearer ${env.TAPMONEY_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000)
    });
  } catch { throw new Error('云端管理服务暂时无法连接。'); }
  if (!response.ok) throw new Error(`云端管理服务请求失败（HTTP ${response.status}）。`);
  return response.json();
}

export async function remoteConfig(env) {
  const saved = await adminRequest('/api/admin/config', { env });
  if (saved.revision === 0) throw new Error('云端配置尚未初始化，请运行 npm run admin:seed。');
  const config = normalizeConfig(saved);
  await atomicWrite(path.join(ROOT, 'config/boards.json'), JSON.stringify(config, null, 2) + '\n');
  return config;
}

export async function uploadSnapshot(env) {
  const data = await readJson(path.join(ROOT, 'site/data/ranking.json'));
  const { metadata, parts } = snapshotTransfer(data);
  const { uploadId } = await adminRequest('/api/internal/snapshot/upload', { env, method: 'POST', body: metadata });
  for (const { board, part, body } of parts) {
    await adminRequest(`/api/internal/snapshot/upload/${uploadId}?board=${board}&part=${part}`, { env, method: 'PUT', body });
  }
  await adminRequest(`/api/internal/snapshot/upload/${uploadId}`, { env, method: 'POST', body: {} });
  console.log('已同步云端收益数据。');
}

if (isMain(import.meta.url)) {
  (async () => {
    const env = await loadEnv();
    if (process.argv.includes('--snapshot')) { await uploadSnapshot(env); return; }
    const current = await adminRequest('/api/admin/config', { env });
    if (current.revision === 0) {
      const config = await loadConfig();
      await adminRequest('/api/admin/config', { env, method: 'PUT', body: { ...config, revision: 0 } });
      console.log('已初始化云端榜单配置。');
    }
    await uploadSnapshot(env);
  })().catch(printError);
}
