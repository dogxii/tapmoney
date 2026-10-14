import { chromium } from 'playwright';
import path from 'node:path';
import { mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ROOT, ORIGIN, USER_AGENT, saveEnv, sleep, printError, loadEnv } from './lib.mjs';

async function login() {
  const profile = path.join(ROOT, '.local/browser-profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(path.join(ROOT, '.local'), 0o700);
  const channel = process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? 'chrome' : undefined;
  const context = await chromium.launchPersistentContext(profile, { headless: false, userAgent: USER_AGENT, channel });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('请在打开的浏览器中完成 TapTap 开发者后台登录。脚本会自动保存凭证，不会打印 Cookie。');
    const deadline = Date.now() + 10 * 60 * 1000;
    let developerId;
    let signedIn = false;
    const existing = await loadEnv();
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('登录窗口已关闭，凭证尚未保存。');
      try {
        const response = await context.request.get(`${ORIGIN}/api/user/v1/me`, { headers: { Referer: `${ORIGIN}/` }, timeout: 10000 });
        if (response.ok()) {
          const me = await response.json();
          if (me.success && me.data) {
            signedIn = true;
            const listResponse = await context.request.get(`${ORIGIN}/api/developer/v1/list`, { headers: { Referer: `${ORIGIN}/` }, timeout: 10000 });
            const studios = listResponse.ok() ? (await listResponse.json()).data?.list ?? [] : [];
            const ids = studios.map(studio => String(studio.developer_id ?? studio.developerId ?? studio.id ?? '')).filter(id => /^\d+$/.test(id));
            // 登录或工作室选择可能打开新标签页；以实际打开的工作室为准。
            const pathId = context.pages().map(tab => tab.url().match(/^https:\/\/developer\.taptap\.cn\/(?:v3\/)?(\d+)(?:\/|$)/)?.[1]).find(id => ids.includes(id));
            if (pathId) developerId = pathId;
            else if (existing.TAPTAP_DEVELOPER_ID && ids.includes(existing.TAPTAP_DEVELOPER_ID)) developerId = existing.TAPTAP_DEVELOPER_ID;
            else if (ids.length === 1) developerId = ids[0];
            else if (ids.length === 0) {
              const value = me.data.developer_id ?? me.data.developerId ?? me.data.developer?.id;
              if (/^\d+$/.test(String(value ?? ''))) developerId = String(value);
            }
            if (developerId) break;
          }
        }
      } catch { /* 页面切换或暂时网络失败时继续等待，绝不打印认证响应。 */ }
      await sleep(3000);
    }
    if (!developerId) throw new Error(signedIn ? '已登录，但未确定工作室。请进入某个工作室的游戏列表页后重试。' : '登录等待超时，请运行 npm run login 重试。');
    const cookies = await context.cookies(`${ORIGIN}/api/mini-app/v1/ad/payout-report-data`);
    const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
    if (!cookie) throw new Error('没有取得开发者后台 Cookie。');
    await saveEnv({ TAPTAP_COOKIE: cookie, TAPTAP_DEVELOPER_ID: developerId });
    console.log(`登录已保存至 .env.local（仅本机用户可读），查询工作室 ID：${developerId}。`);
  } finally { await context.close(); }
}

login().catch(error => {
  if (/Executable doesn't exist/.test(error.message)) printError(new Error('请先运行 npm exec playwright install chromium 安装登录浏览器。'));
  else printError(new Error('登录未完成。请确认浏览器登录成功并进入工作室；需要时运行 npm exec playwright install chromium。'));
});
