import { spawn } from 'node:child_process';
import { loadEnv, printError } from './lib.mjs';

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
  const keys = ['TAPTAP_COOKIE', 'TAPTAP_DEVELOPER_ID'];
  if (keys.some(key => !env[key])) throw new Error('缺少采集凭证，请先运行 npm run login。');
  for (const key of keys) await gh(['secret', 'set', key, '--repo', repository], env[key]);
  console.log(`已配置 ${repository} 的 TapTap Actions 凭证；未打印或提交凭证。`);
}

setup().catch(printError);
