import { node, icon, iconButton, money } from './ui.js';
import { metricValue, chartSeries, chartSegments, periodGrowth } from './data-utils.js';
import { metricLabels, fileName, periodLabel, rankingCsv } from './export-data.js';

const ink = '#202024', muted = '#85858e', line = '#e8e8ec', blue = '#4c78df';
const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const imageCache = new Map();
let disposePreview;
const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

function image(url) {
  if (!url) return Promise.resolve(null);
  if (imageCache.has(url)) return imageCache.get(url);
  const promise = new Promise(resolve => {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
    const finish = value => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish(null), 8000);
    img.onload = () => finish(img); img.onerror = () => finish(null); img.src = url;
  });
  imageCache.set(url, promise); return promise;
}

function canvas(height) {
  const element = document.createElement('canvas'); element.width = 1080; element.height = height;
  const ctx = element.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, element.width, element.height);
  ctx.textBaseline = 'alphabetic';
  return { element, ctx };
}

function text(ctx, value, x, y, size = 24, color = ink, weight = 400, maxWidth) {
  ctx.font = `${weight} ${size}px ${font}`; ctx.fillStyle = color;
  let label = String(value);
  if (maxWidth) {
    const characters = Array.from(label);
    while (characters.length && ctx.measureText(characters.join('') + '…').width > maxWidth) characters.pop();
    if (ctx.measureText(label).width > maxWidth) label = characters.join('') + '…';
  }
  ctx.fillText(label, x, y);
}

function rule(ctx, y) { ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(64, y); ctx.lineTo(1016, y); ctx.stroke(); }

async function portrait(ctx, url, name, x, y, size, radius = 16) {
  const img = await image(url);
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, size, size, radius); ctx.clip();
  ctx.fillStyle = '#f2f2f4'; ctx.fillRect(x, y, size, size);
  if (img) {
    const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
    ctx.drawImage(img, x + (size - img.naturalWidth * scale) / 2, y + (size - img.naturalHeight * scale) / 2, img.naturalWidth * scale, img.naturalHeight * scale);
  } else { ctx.textAlign = 'center'; text(ctx, Array.from(name)[0] ?? '?', x + size / 2, y + size * .65, size * .4, muted); }
  ctx.restore();
}

function footer(ctx, y, left, right = 'TapMoney · TapTap 小游戏广告收益') {
  rule(ctx, y - 30); text(ctx, left, 64, y + 5, 19, muted, 400, 560);
  ctx.textAlign = 'right'; text(ctx, right, 1016, y + 5, 18, muted, 400, 400); ctx.textAlign = 'left';
}

function chart(ctx, rows, mode, y) {
  const width = 952, height = 330, left = 76, right = 16, top = 30, bottom = 42;
  if (!rows.length) { text(ctx, '暂无日报', 64, y + height / 2, 24, muted); return; }
  const first = Date.parse(rows[0].date), last = Date.parse(rows.at(-1).date);
  const min = Math.min(0, ...rows.map(row => row.revenue)), max = Math.max(1, ...rows.map(row => row.revenue)) * 1.08;
  const px = row => 64 + left + (first === last ? .5 : (Date.parse(row.date) - first) / (last - first)) * (width - left - right);
  const py = row => y + top + (max - row.revenue) / (max - min) * (height - top - bottom);
  for (let index = 0; index < 3; index++) {
    const amount = min + (max - min) * index / 2, cy = py({ revenue: amount });
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(64 + left, cy); ctx.lineTo(1016 - right, cy); ctx.stroke();
    ctx.textAlign = 'right'; text(ctx, new Intl.NumberFormat('zh-CN', {notation: 'compact',maximumFractionDigits: 1}).format(amount), 64 + left - 14, cy + 7, 18, muted); ctx.textAlign = 'left';
  }
  for (const segment of chartSegments(rows, mode)) {
    ctx.strokeStyle = blue; ctx.fillStyle = blue; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
    if (segment.length === 1) { ctx.arc(px(segment[0]), py(segment[0]), 4, 0, Math.PI * 2); ctx.fill(); }
    else { segment.forEach((row, index) => index ? ctx.lineTo(px(row), py(row)) : ctx.moveTo(px(row), py(row))); ctx.stroke(); }
  }
  text(ctx, rows[0].date, 64 + left, y + height - 6, 18, muted);
  ctx.textAlign = 'right'; if (rows.length > 1) text(ctx, rows.at(-1).date, 1000, y + height - 6, 18, muted); ctx.textAlign = 'left';
}

function blob(element) {
  return new Promise((resolve, reject) => element.toBlob(value => value ? resolve(value) : reject(new Error('图片生成失败。')), 'image/png'));
}

async function gameCard({ game, snapshot, profiles, mode, days }) {
  await document.fonts.ready;
  const { element, ctx } = canvas(930);
  text(ctx, 'TapMoney', 64, 62, 22, muted, 600);
  await portrait(ctx, game.iconUrl, game.name, 64, 106, 84, 22);
  text(ctx, game.name, 170, 146, 36, ink, 600, 830);
  const authors = (game.authorIds ?? []).map(id => profiles.get(id)).filter(Boolean);
  if (authors.length) {
    await portrait(ctx, authors[0].avatarUrl, authors[0].name, 172, 164, 25, 13);
    text(ctx, authors.map(author => author.name).join(' / '), 209, 184, 21, muted, 400, 785);
  }
  for (const [index, key] of ['yesterday', 'month', 'total'].entries()) {
    const x = 64 + index * 330;
    text(ctx, key === 'total' ? '累计收益' : `${metricLabels[key]}收益`, x, 260, 22, muted);
    const value = metricValue(game, key, snapshot);
    text(ctx, value === null ? '—' : money.format(value), x, 313, 39, ink, 550, 315);
    const growth = periodGrowth(game, key, snapshot);
    if (growth !== null) text(ctx, `${growth > 0 ? '+' : ''}${growth.toFixed(1)}% ${key === 'month' ? '较上月同期' : '较前日'}`, x, 351, 18, growth > 0 ? '#29aa72' : growth < 0 ? '#d05c5c' : muted);
  }
  rule(ctx, 390);
  text(ctx, `${mode === 'cumulative' ? '累计' : '每日'}收益 · ${days ? `${days} 天` : '全部'} · CNY`, 64, 446, 22, muted);
  chart(ctx, chartSeries(game.history ?? [], mode, days, game.asOf), mode, 474);
  const date = game.asOf ? `截至 ${game.asOf}${game.asOf !== snapshot.asOf ? ' · 历史数据' : ''}` : '待采集';
  footer(ctx, 882, date);
  return blob(element);
}

async function rankingCard({ rows, snapshot, metric, profiles, filter, page = 1, pages = 1 }) {
  await document.fonts.ready;
  const { element, ctx } = canvas(300 + Math.max(1, rows.length) * 112);
  text(ctx, `${snapshot.name ?? '收益榜'} · ${metricLabels[metric]}`, 64, 96, 42, ink, 600, 760);
  ctx.textAlign = 'right'; text(ctx, 'TapMoney', 1016, 92, 24, muted, 600); ctx.textAlign = 'left';
  text(ctx, periodLabel(snapshot, metric), 64, 145, 23, muted);
  if (filter) text(ctx, `筛选：${filter}`, 64, 178, 19, muted, 400, 900);
  rule(ctx, 204);
  await Promise.all(rows.map(row => image(row.game.iconUrl)));
  for (const [index, row] of rows.entries()) {
    const y = 222 + index * 112;
    text(ctx, row.rank ?? '—', 64, y + 48, 24, muted);
    await portrait(ctx, row.game.iconUrl, row.game.name, 119, y + 15, 64, 16);
    text(ctx, row.game.name, 204, y + 42, 27, ink, 550, 475);
    const names = (row.game.authorIds ?? []).map(id => profiles.get(id)?.name).filter(Boolean).join(' / ');
    text(ctx, names, 204, y + 76, 20, muted, 400, 460);
    ctx.textAlign = 'right'; text(ctx, row.amount === null ? '—' : money.format(row.amount), 1016, y + 45, 31, row.amount === null ? muted : ink, 550);
    if (row.growth !== null) text(ctx, `${row.growth > 0 ? '+' : ''}${row.growth.toFixed(1)}% ${metric === 'month' ? '较上月同期' : '较前日'}`, 1016, y + 76, 18, row.growth > 0 ? '#29aa72' : row.growth < 0 ? '#d05c5c' : muted);
    ctx.textAlign = 'left';
  }
  if (!rows.length) text(ctx, '暂无匹配数据', 64, 282, 24, muted);
  footer(ctx, element.height - 40, `已收录游戏 · ${rows.length} 款${pages > 1 ? ` · ${page}/${pages}` : ''}`);
  return blob(element);
}

function download(data, name) {
  const url = URL.createObjectURL(data), link = node('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function exportDialog(title) {
  let dialog = document.querySelector('#export-dialog');
  if (!dialog) {
    dialog = node('dialog', 'export-dialog'); dialog.id = 'export-dialog'; document.body.append(dialog);
    dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  }
  disposePreview?.();
  if (dialog.open) dialog.close(); dialog.replaceChildren(); dialog.setAttribute('aria-label', title);
  const header = node('div', 'dialog-header'); header.append(node('h2', '', title));
  const close = iconButton('close', '关闭导出'); close.addEventListener('click', () => dialog.close()); header.append(close);
  const body = node('div'), status = node('p', 'export-status'); status.setAttribute('role', 'status');
  const actions = node('div', 'export-actions');
  dialog.append(header, body, status, actions); dialog.showModal();
  let active = true;
  const urls = [];
  const onClose = () => { if (!dialog.open) dispose(); };
  const dispose = () => { active = false; urls.forEach(url => URL.revokeObjectURL(url)); dialog.removeEventListener('close', onClose); };
  disposePreview = dispose;
  dialog.addEventListener('close', onClose);
  return {
    body, status, actions, active: () => active,
    message: (value, error = false) => { status.textContent = value; status.classList.toggle('error', error); },
    preview: data => { const url = URL.createObjectURL(data); urls.push(url); const img = node('img', 'export-preview'); img.src = url; img.alt = title; body.replaceChildren(img); },
    button: (label, handler, primary = false) => { const button = node('button', primary ? 'primary-button' : 'secondary-button', label); button.type = 'button'; button.addEventListener('click', async () => { button.disabled = true; try { await handler(); } catch (error) { status.textContent = error.message || '暂时无法导出'; status.classList.add('error'); } finally { button.disabled = false; } }); actions.append(button); return button; }
  };
}

function shareButton(view, getFile) {
  if (!navigator.canShare) return () => {};
  const button = view.button('分享', async () => {
    const file = getFile(); if (!file) return;
    try { await navigator.share({ files: [file] }); } catch (error) { if (error.name !== 'AbortError') throw new Error('分享失败，请保存 PNG。'); }
  });
  button.hidden = true;
  return () => { const file = getFile(); button.hidden = !file || !navigator.canShare({ files: [file] }); };
}

export async function showRankingExport(options) {
  const view = exportDialog('导出榜单');
  const name = fileName(`TapMoney-${options.snapshot.name ?? '收益榜'}-${metricLabels[options.metric]}-${options.snapshot.asOf ?? '待采集'}`);
  let png;
  const save = view.button('保存 PNG', () => { if (png) download(png, `${name}.png`); }, true); save.disabled = true;
  if (options.rows.length > 20) view.button('全部分页 ZIP', async () => {
    const { zipFiles } = await import('./zip.js');
    const files = [], pages = Math.ceil(options.rows.length / 20);
    for (let index = 0; index < pages; index++) {
      if (!view.active()) return;
      view.message(`生成 ${index + 1}/${pages}`);
      const data = await rankingCard({ ...options, rows: options.rows.slice(index * 20, (index + 1) * 20), page: index + 1, pages });
      files.push({ name: `${name}-${String(index + 1).padStart(2, '0')}.png`, bytes: new Uint8Array(await data.arrayBuffer()) });
    }
    download(zipFiles(files), `${name}.zip`); view.message('已导出全部分页');
  });
  view.button('CSV', () => download(new Blob([rankingCsv(options.rows, options.snapshot, options.metric, options.profiles)], {type: 'text/csv;charset=utf-8'}), `${name}.csv`));
  const readyShare = shareButton(view, () => png && new File([png], `${name}.png`, {type: 'image/png'}));
  view.message('生成中…');
  try {
    png = await rankingCard({ ...options, rows: options.rows.slice(0, 20) });
    if (!view.active()) return;
    view.preview(png); save.disabled = false; readyShare();
    view.message(options.rows.length > 20 ? `预览前 20 款 · 共 ${options.rows.length} 款` : '');
  } catch { if (view.active()) view.message('图片生成失败，请重试', true); }
}

async function fetchAsset(item) {
  const response = await fetch(item.url, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || !types[mime] || Number(response.headers.get('Content-Length')) > 12 * 1024 * 1024) throw new Error('图片暂时无法下载');
  const data = await response.blob();
  if (!data.size || data.size > 12 * 1024 * 1024) throw new Error('图片体积不支持');
  return { data, extension: types[mime] };
}

function assetList(game) {
  const list = game.media?.length ? game.media : game.iconUrl ? [{kind: 'logo', url: game.iconUrl}] : [];
  let count = 0;
  return list.map(item => ({ ...item, label: item.kind === 'logo' ? 'Logo' : `截图 ${++count}` }));
}

export async function showGameExport(options) {
  const view = exportDialog('导出游戏');
  const tabs = node('div', 'tabs export-tabs');
  let png, generation = 0;
  const name = fileName(`${options.game.name}-${options.game.asOf ?? '待采集'}`);
  for (const [key, label] of [['card', '统计卡'], ['assets', '素材']]) {
    const tab = node('button', '', label); tab.type = 'button';
    tab.addEventListener('click', () => render(key)); tabs.append(tab);
  }
  view.body.before(tabs);
  async function render(mode) {
    const current = ++generation;
    [...tabs.children].forEach((tab, index) => { const active = index === (mode === 'card' ? 0 : 1); tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
    view.body.replaceChildren(); view.actions.replaceChildren(); view.message('');
    if (mode === 'card') {
      const save = view.button('保存 PNG', () => png && download(png, `${name}.png`), true); save.disabled = true;
      const readyShare = shareButton(view, () => png && new File([png], `${name}.png`, {type: 'image/png'}));
      view.message('生成中…');
      try {
        png ??= await gameCard(options);
        if (!view.active() || current !== generation) return;
        view.preview(png); save.disabled = false; readyShare(); view.message('');
      } catch { if (view.active() && current === generation) view.message('图片生成失败，请重试', true); }
      return;
    }
    const items = assetList(options.game);
    const grid = node('div', 'asset-grid');
    if (!items.length) { view.body.append(node('div', 'empty', '暂无素材')); return; }
    items.forEach(item => {
      const tile = node('div', `asset-tile ${item.kind}`), img = node('img'); img.src = item.url; img.alt = item.label; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      const controls = node('div', 'asset-controls'); controls.append(node('span', '', item.label));
      const save = iconButton('download', `保存${item.label}`); save.addEventListener('click', async () => {
        save.disabled = true; try { const {data, extension} = await fetchAsset(item); download(data, `${fileName(options.game.name)}-${item.label}.${extension}`); view.message(''); } catch { view.message(`${item.label}暂时无法下载，可打开原链接保存`, true); } finally { save.disabled = false; }
      });
      const link = node('a', 'icon-button'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = `打开${item.label}`; link.setAttribute('aria-label', link.title); link.append(icon('external'));
      controls.append(save, link); tile.append(img, controls); grid.append(tile);
    });
    view.body.append(grid);
    view.button('全部素材 ZIP', async () => {
      const { zipFiles } = await import('./zip.js'); const files = [], failed = [];
      for (const [index, item] of items.entries()) {
        if (!view.active() || current !== generation) return;
        view.message(`下载 ${index + 1}/${items.length}`);
        try { const {data, extension} = await fetchAsset(item); files.push({name: `${fileName(options.game.name)}-${item.label}.${extension}`, bytes: new Uint8Array(await data.arrayBuffer())}); } catch { failed.push(item.label); }
      }
      if (!files.length) throw new Error('素材暂时无法下载，可打开原链接保存');
      if (failed.length) files.push({name: '未成功下载.txt', bytes: new TextEncoder().encode(failed.join('\n'))});
      download(zipFiles(files), `${fileName(options.game.name)}-素材.zip`);
      view.message(failed.length ? `已保存可用素材 · ${failed.join('、')}未成功` : `已保存 ${items.length} 张素材`, Boolean(failed.length));
    }, true);
  }
  render(options.initialTab ?? 'card');
}
