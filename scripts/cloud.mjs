import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, loadEnv } from './lib.mjs';
import { mkdir } from 'node:fs/promises';

export async function wrangler(args, { env, capture = false, input, cwd = path.join(ROOT, '.local/cloudflare') } = {}) {
  env ??= await loadEnv();
  const childEnv = { ...process.env };
  childEnv.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  for (const key of Object.keys(childEnv)) if (key.startsWith('TAPTAP_') || key.startsWith('TAPMONEY_')) delete childEnv[key];
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) if (env[key]) childEnv[key] = env[key];
  await mkdir(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
      cwd, env: childEnv, stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit']
    });
    let output = '';
    if (capture) { child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', () => {}); }
    if (input !== undefined) child.stdin.end(input + '\n');
    child.on('error', () => reject(new Error('无法启动 Wrangler。')));
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`Cloudflare 操作失败：${args.slice(0, 2).join(' ')}。`)));
  });
}
