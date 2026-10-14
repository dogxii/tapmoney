import { spawn } from 'node:child_process';
import { loadEnv, printError } from './lib.mjs';
import { configSource } from '../shared/config.mjs';

async function gh(args, input) {
  await new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {});
    child.stdin.end(input ?? '');
    child.on('error', () => reject(new Error('请先安装 GitHub CLI 并运行 gh auth login。')));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`GitHub 配置失败：${args.slice(0, 3).join(' ')}。`)));
  });
}

async function setup() {
  const repository = process.argv[2];
  if (!/^[\w-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('用法：npm run setup:github -- 你的用户名/仓库名');
  const env = await loadEnv();
  const source = configSource(env);
  const keys = ['TAPTAP_COOKIE', 'TAPTAP_DEVELOPER_ID', ...(source === 'cloud' ? ['TAPMONEY_ADMIN_TOKEN'] : [])];
  if (keys.some(key => !env[key])) throw new Error('缺少采集凭证，请先运行 npm run login；在线管理模式还需要 npm run admin:setup。');
  if (source === 'cloud' && !env.TAPMONEY_API_URL) throw new Error('在线管理模式缺少 TAPMONEY_API_URL。');
  for (const key of keys) await gh(['secret', 'set', key, '--repo', repository], env[key]);
  if (source === 'cloud') await gh(['variable', 'set', 'TAPMONEY_API_URL', '--repo', repository, '--body', env.TAPMONEY_API_URL]);
  await gh(['variable', 'set', 'TAPMONEY_CONFIG_SOURCE', '--repo', repository, '--body', source]);
  console.log(`已配置 ${repository} 的 Actions 凭证和 ${source} 模式；未打印或提交凭证。`);
}

setup().catch(printError);
