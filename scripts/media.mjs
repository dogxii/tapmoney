import { createHash } from 'node:crypto';
import { mkdir, stat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, atomicWrite } from './lib.mjs';
import { staticMediaUrl } from '../shared/media.mjs';

const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const maxBytes = 12 * 1024 * 1024;

export function allowedImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'tapimg.com' || url.hostname.endsWith('.tapimg.com') || ['q.qlogo.cn', 'q1.qlogo.cn', 'q2.qlogo.cn'].includes(url.hostname));
  } catch { return false; }
}

export async function cacheMedia(catalog, { directory = path.join(ROOT, 'site/media'), request = fetch, retainMedia = [] } = {}) {
  await mkdir(directory, { recursive: true });
  const kept = new Set(retainMedia.filter(staticMediaUrl).map(url => url.split('/').at(-1)));
  const cached = new Map();
  async function save(url) {
    if (staticMediaUrl(url)) { kept.add(url.split('/').at(-1)); return url; }
    if (!allowedImage(url)) return url;
    if (cached.has(url)) return cached.get(url);
    let fallback;
    const task = (async () => {
      const hash = createHash('sha256').update(url).digest('hex');
      for (const extension of Object.values(types)) {
        const filename = `${hash}.${extension}`;
        try {
          const info = await stat(path.join(directory, filename));
          fallback = `/media/${filename}`; kept.add(filename);
          if (!new URL(url).hostname.endsWith('qlogo.cn') || Date.now() - info.mtimeMs < 7 * 86400000) return fallback;
        } catch { /* 尚未缓存。 */ }
      }
      let response;
      let current = url;
      for (let hop = 0; hop < 4; hop++) {
        if (!allowedImage(current)) throw new Error('图片跳转域名不支持。');
        response = await request(current, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'image/*' } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        current = new URL(response.headers.get('Location'), current).href;
        response = null;
      }
      if (!response?.ok) throw new Error('图片下载失败。');
      const extension = types[response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()];
      if (!extension || Number(response.headers.get('Content-Length')) > maxBytes) throw new Error('图片格式或体积不支持。');
      const reader = response.body.getReader();
      const chunks = []; let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) { await reader.cancel(); throw new Error('图片体积过大。'); }
        chunks.push(value);
      }
      if (!length) throw new Error('图片为空。');
      const filename = `${hash}.${extension}`;
      await atomicWrite(path.join(directory, filename), Buffer.concat(chunks));
      kept.add(filename);
      return `/media/${filename}`;
    })().catch(() => fallback ?? url);
    cached.set(url, task);
    return task;
  }
  for (const game of Object.values(catalog.games)) {
    game.iconSourceUrl = game.iconUrl;
    game.media = await Promise.all((game.media ?? []).map(async item => ({ ...item, url: await save(item.url) })));
    game.iconUrl = await save(game.iconUrl);
  }
  for (const author of catalog.authors) { author.avatarSourceUrl = author.avatarUrl; author.avatarUrl = await save(author.avatarUrl); }
  // 只清理本模块创建的图片，不接触其他站点资源。
  for (const filename of await readdir(directory)) if (/^[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$/.test(filename) && !kept.has(filename)) await unlink(path.join(directory, filename));
  return catalog;
}
