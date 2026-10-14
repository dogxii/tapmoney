import { validId, validDate, imageUrl, normalizeGames } from '../shared/config.mjs';
export { validId, validDate, imageUrl, normalizeGames } from '../shared/config.mjs';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const ORIGIN = 'https://developer.taptap.cn';
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const ENV_FILE = path.join(ROOT, '.env.local');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function isMain(url) {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === url;
}

export async function loadEnv() {
  let saved = {};
  try { saved = parseEnv(await readFile(ENV_FILE, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // 系统环境变量优先，但空值不覆盖已保存的凭证。
  return { ...saved, ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== '')) };
}

function quoteEnv(value) {
  value = String(value);
  if (/[\r\n]/.test(value)) throw new Error('环境变量值不能包含换行。');
  const quote = ['"', "'", '`'].find(character => !value.includes(character));
  if (!quote) throw new Error('环境变量值包含无法保存的引号组合。');
  return `${quote}${value}${quote}`;
}

export async function saveEnv(updates) {
  let previous = {};
  try { previous = parseEnv(await readFile(ENV_FILE, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const values = { ...previous, ...updates };
  const content = '# 仅供本地脚本使用，禁止发布到静态网站。\n' +
    Object.entries(values).map(([key, value]) => `${key}=${quoteEnv(value)}`).join('\n') + '\n';
  await atomicWrite(ENV_FILE, content, 0o600);
  await chmod(ENV_FILE, 0o600);
}

export async function atomicWrite(destination, content, mode = 0o644) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, destination);
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function periods(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return { today, asOf: yesterday.toISOString().slice(0, 10), monthStart: `${today.slice(0, 7)}-01` };
}

export class AuthenticationError extends Error {
  constructor() { super('开发者后台登录会话已失效或未被接受，请运行 npm run login 重新登录。'); }
}

export class RateLimitError extends Error {
  constructor() { super('TapTap 触发请求限流（HTTP 429），已停止本轮采集，请稍后再试。'); }
}

export class TapTapClient {
  constructor(env, { request = fetch, wait = sleep } = {}) {
    if (!env.TAPTAP_COOKIE) throw new Error('还没有开发者后台登录凭证，请先运行 npm run login。');
    this.cookie = env.TAPTAP_COOKIE;
    this.request = request;
    this.wait = wait;
    this.delay = Number(env.TAPTAP_REQUEST_DELAY_MS ?? 3000);
    if (!Number.isFinite(this.delay) || this.delay < 0) throw new Error('TAPTAP_REQUEST_DELAY_MS 必须是非负数字。');
    this.nextRequestAt = 0;
  }

  async get(route, query = {}) {
    const url = new URL(route, ORIGIN);
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/')) throw new Error('采集脚本只允许请求 TapTap 开发者后台 API。');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.wait(Math.max(0, this.nextRequestAt - Date.now()));
      this.nextRequestAt = Date.now() + this.delay;
      let response;
      try {
        response = await this.request(url, {
          headers: { Cookie: this.cookie, Referer: `${ORIGIN}/`, 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' },
          signal: AbortSignal.timeout(30000), redirect: 'error'
        });
      } catch {
        if (attempt < 2) { await this.wait(1000 * (attempt + 1)); continue; }
        throw new Error('TapTap 网络请求失败或超时。');
      }
      if (response.status === 401) throw new AuthenticationError();
      if (response.status === 403) throw new Error('TapTap 拒绝本次接口访问（HTTP 403）；不代表登录会话已过期。');
      if (response.status === 429) throw new RateLimitError();
      if (response.status >= 500) {
        if (attempt < 2) { await this.wait(2000 * (attempt + 1)); continue; }
      }
      if (!response.ok) throw new Error(`TapTap 接口请求失败（HTTP ${response.status}）。`);
      let json;
      try { json = await response.json(); }
      catch { throw new Error('TapTap 未返回有效 JSON。'); }
      if (json.success !== true || !json.data) {
        const message = String(json.data?.msg ?? json.message ?? json.msg ?? '');
        if (/未认证|未登录|登录失效|登录过期|unauth|token.*expired/i.test(message)) throw new AuthenticationError();
        throw new Error('TapTap 接口未返回成功数据。');
      }
      return json.data;
    }
  }

  async revenue(developerId, appId, start, end) {
    return (await this.report(developerId, appId, start, end)).total;
  }

  async report(developerId, appId, start, end) {
    const data = await this.get('/api/mini-app/v1/ad/payout-report-data', {
      developer_id: validId(developerId, 'developer_id'), app_id: validId(appId, 'app_id'),
      start_time: start, end_time: end
    });
    return { total: revenueTotal(data), history: revenueHistory(data, start, end) };
  }
}

export function revenueHistory(data, start, end) {
  const rows = new Map();
  for (const item of data.list ?? []) {
    if (!validDate(item.date) || item.date < start || item.date > end) continue;
    if (!['number', 'string'].includes(typeof item.revenue) || String(item.revenue).trim() === '') continue;
    const revenue = Number(item.revenue);
    if (!Number.isFinite(revenue)) throw new Error('收益日报金额无效。');
    rows.set(item.date, { date: item.date, revenue });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function revenueTotal(data) {
  if (data.in_error === true) throw new Error('收益报表标记为异常，暂不更新金额。');
  const number = value => {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw new Error('收益金额字段缺失。');
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error('收益金额不是有效数字。');
    return result;
  };
  if (['number', 'string'].includes(typeof data.total) && String(data.total).trim() !== '') return number(data.total);
  if (data.total && typeof data.total === 'object' && ['number', 'string'].includes(typeof data.total.revenue) && String(data.total.revenue).trim() !== '') return number(data.total.revenue);
  if (!Array.isArray(data.list)) throw new Error('收益报表缺少合计和每日记录。');
  // 上游用空字符串填充没有收益记录的日期（包括游戏上线前）。
  // 只合计有数字的日报；整段无记录时保持 null，真实的 0 仍是 0。
  const values = data.list.filter(item => !(typeof item.revenue === 'string' && item.revenue.trim() === '')).map(item => number(item.revenue));
  return values.length ? Number(values.reduce((sum, value) => sum + value, 0).toFixed(2)) : null;
}

export function printError(error) {
  // 不输出请求对象、响应正文或 stack，避免把登录凭证写进运行日志。
  console.error(error instanceof Error ? error.message : '运行失败。');
  process.exitCode = 1;
}
