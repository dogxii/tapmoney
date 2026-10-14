import path from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { ROOT, loadEnv, printError } from './lib.mjs';

const label = 'cn.tapmoney.daily';
const file = path.join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function schedule() {
  if (process.platform !== 'darwin') throw new Error('这个安装器用于 macOS；其他系统请用定时器每天运行 npm run daily。');
  const action = process.argv[2] ?? 'help';
  if (action === 'remove') {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, file], { stdio: 'ignore' });
    await rm(file, { force: true });
    console.log('已移除每日任务。'); return;
  }
  if (!['install', 'preview'].includes(action)) {
    console.log('安装：npm run schedule -- install --time 10:30\n预览：npm run schedule -- preview --time 10:30\n移除：npm run schedule -- remove'); return;
  }
  const timeIndex = process.argv.indexOf('--time');
  const time = timeIndex >= 0 ? process.argv[timeIndex + 1] : '10:30';
  if (!time) throw new Error('--time 后需要填写 HH:MM。');
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('--time 使用 HH:MM 格式。');
  const logDir = path.join(ROOT, '.local/logs');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(ROOT, 'scripts/daily.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(ROOT)}</string>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(match[1])}</integer><key>Minute</key><integer>${Number(match[2])}</integer></dict>
<key>StandardOutPath</key><string>${xml(path.join(logDir, 'daily.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logDir, 'daily-error.log'))}</string>
</dict></plist>\n`;
  if (action === 'preview') { console.log(plist); return; }
  const env = await loadEnv();
  if (!env.TAPTAP_COOKIE || !env.TAPTAP_DEVELOPER_ID || !env.CLOUDFLARE_PAGES_PROJECT) throw new Error('请先完成 TapTap 登录并配置 Cloudflare Pages 项目，再安装每日任务。');
  await access(path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'));
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await writeFile(file, plist);
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, file], { stdio: 'ignore' });
  const result = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, file], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('launchd 注册失败，配置文件已保存供检查。');
  console.log(`已安装每天 ${time}（本机时区）的自动采集和发布任务。电脑关机时不会运行。`);
}

schedule().catch(printError);
