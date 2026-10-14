import { readFile, chmod } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { loadEnv, printError } from './lib.mjs';
import { wrangler } from './cloud.mjs';

async function setup() {
  const { values, positionals } = parseArgs({ options: { 'token-file': { type: 'string' } }, allowPositionals: true });
  const repository = positionals[0];
  if (!/^[\w-]+\/[\w.-]+$/.test(repository ?? '') || positionals.length !== 1) throw new Error('用法：npm run collect:setup -- 用户名/仓库名 --token-file .local/github-actions-token.txt');
  const env = await loadEnv();
  const project = env.CLOUDFLARE_PAGES_PROJECT;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project ?? '')) throw new Error('请先配置 CLOUDFLARE_PAGES_PROJECT。');
  const token = (values['token-file'] ? await readFile(values['token-file'], 'utf8') : env.TAPMONEY_COLLECT_TOKEN ?? '').trim();
  if (!/^github_pat_[A-Za-z0-9_]+$/.test(token)) throw new Error('需要仅授权此仓库的 fine-grained Token，权限为 Actions: Read and write。');
  if (values['token-file']) await chmod(values['token-file'], 0o600);
  await new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', `repos/${repository}/actions/workflows/collect.yml`], { env: { ...process.env, GH_TOKEN: token }, stdio: 'ignore' });
    child.on('error', () => reject(new Error('请安装 GitHub CLI。')));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('专用 Token 无法读取此仓库的采集工作流，请检查仓库和 Actions 权限。')));
  });
  await wrangler(['pages', 'secret', 'put', 'COLLECT_REPOSITORY', '--project-name', project], { env, input: repository, capture: true });
  await wrangler(['pages', 'secret', 'put', 'COLLECT_TOKEN', '--project-name', project], { env, input: token, capture: true });
  console.log('已配置 Pages 手动采集凭证；重新部署后生效，未输出 Token。');
}

setup().catch(printError);
