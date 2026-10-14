import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT, loadEnv, saveEnv, atomicWrite, printError } from './lib.mjs';
import { wrangler } from './cloud.mjs';

try {
  let env = await loadEnv();
  const project = env.CLOUDFLARE_PAGES_PROJECT;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project ?? '')) throw new Error('请先配置 CLOUDFLARE_PAGES_PROJECT。');
  const database = env.TAPMONEY_D1_DATABASE || `${project}-db`;
  const token = env.TAPMONEY_ADMIN_TOKEN || randomBytes(32).toString('base64url');
  const listed = await wrangler(['d1', 'list', '--json'], { env, capture: true });
  let id = JSON.parse(listed.slice(listed.indexOf('['))).find(item => item.name === database)?.uuid;
  if (!id) {
    const output = await wrangler(['d1', 'create', database], { env, capture: true });
    id = output.match(/"database_id"\s*:\s*"([a-f0-9-]+)"/)?.[1];
    if (!id) throw new Error('未读取到新数据库 ID，请检查 Cloudflare。');
  }
  const configFile = path.join(ROOT, '.local/d1.json');
  await atomicWrite(configFile, JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: database, database_id: id }] }), 0o600);
  await wrangler(['d1', 'execute', database, '--config', configFile, '--remote', '--file', path.join(ROOT, 'server/schema.sql'), '--yes'], { env });
  await wrangler(['pages', 'secret', 'put', 'ADMIN_TOKEN_HASH', '--project-name', project], { env, input: createHash('sha256').update(token).digest('hex') });
  await saveEnv({ TAPMONEY_CONFIG_SOURCE: 'cloud', TAPMONEY_ADMIN_TOKEN: token, TAPMONEY_API_URL: env.TAPMONEY_API_URL || `https://${project}.pages.dev`, TAPMONEY_D1_DATABASE: database });
  await atomicWrite(path.join(ROOT, '.local/admin-token.txt'), token + '\n', 0o600);
  console.log(`数据库 ${database} 已初始化；请在 Pages 设置中将它绑定为 DB，构建环境设置 TAPMONEY_CONFIG_SOURCE=cloud。管理 Token 保存在 .local/admin-token.txt。`);
} catch (error) { printError(error); }
