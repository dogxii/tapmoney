import { money, node, portrait, authorLink, iconButton } from './ui.js';
import { metricValue, periodGrowth, chartSeries, chartSegments } from './data-utils.js';

const svgNode = (tag, attributes = {}, text) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
};

function drawChart(container, rows, mode) {
  container.replaceChildren();
  if (!rows.length) { container.append(node('div', 'chart-empty', '暂无日报')); return; }
  const width = Math.max(280, container.clientWidth || 760), height = width < 500 ? 218 : 248;
  const left = width < 500 ? 52 : 68, right = 22, top = 22, bottom = 37;
  const first = Date.parse(rows[0].date), last = Date.parse(rows.at(-1).date);
  const minimum = Math.min(0, ...rows.map(row => row.revenue));
  const maximum = Math.max(1, ...rows.map(row => row.revenue)) * 1.08;
  const x = row => first === last ? (width + left - right) / 2 : left + (Date.parse(row.date) - first) / (last - first) * (width - left - right);
  const y = row => top + (maximum - row.revenue) / (maximum - minimum) * (height - top - bottom);
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: '0', 'aria-label': `${mode === 'daily' ? '每日' : '累计'}广告收益曲线，${rows[0].date} 至 ${rows.at(-1).date}。使用左右方向键查看日报。` });
  for (let i = 0; i < 3; i++) {
    const value = minimum + (maximum - minimum) * i / 2;
    const py = y({ revenue: value });
    svg.append(svgNode('line', { x1: left, x2: width - right, y1: py, y2: py, class: 'chart-grid' }));
    const label = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    svg.append(svgNode('text', { x: left - 12, y: py + 4, 'text-anchor': 'end', class: 'chart-label' }, `¥${label}`));
  }
  const labels = rows.length === 1 ? [rows[0]] : [rows[0], rows.at(-1)];
  for (const row of labels) svg.append(svgNode('text', { x: x(row), y: height - 10, 'text-anchor': row === rows[0] && rows.length > 1 ? 'start' : 'end', class: 'chart-label' }, row.date.slice(5).replace('-', '.')));
  for (const segment of chartSegments(rows, mode)) {
    if (segment.length === 1) svg.append(svgNode('circle', { cx: x(segment[0]), cy: y(segment[0]), r: 3.3, class: 'chart-point' }));
    else svg.append(svgNode('path', { d: segment.map((row, i) => `${i ? 'L' : 'M'}${x(row).toFixed(2)},${y(row).toFixed(2)}`).join(' '), class: 'chart-line' }));
  }
  const cross = svgNode('line', { y1: top, y2: height - bottom, class: 'chart-cross', visibility: 'hidden' });
  const point = svgNode('circle', { r: 4, class: 'chart-point', visibility: 'hidden' });
  svg.append(cross, point);
  const tooltip = node('div', 'chart-tooltip'); tooltip.hidden = true; tooltip.setAttribute('role', 'status');
  container.append(svg, tooltip);
  let index = rows.length - 1;
  const show = () => {
    const row = rows[index];
    cross.setAttribute('x1', x(row)); cross.setAttribute('x2', x(row)); cross.setAttribute('visibility', 'visible');
    point.setAttribute('cx', x(row)); point.setAttribute('cy', y(row)); point.setAttribute('visibility', 'visible');
    tooltip.replaceChildren(node('span', '', row.date), node('strong', '', money.format(row.revenue)));
    tooltip.style.left = `${Math.min(78, Math.max(15, x(row) / width * 100))}%`;
    tooltip.hidden = false;
  };
  svg.addEventListener('pointermove', event => {
    const px = (event.clientX - svg.getBoundingClientRect().left) / svg.getBoundingClientRect().width * width;
    index = rows.reduce((best, row, i) => Math.abs(x(row) - px) < Math.abs(x(rows[best]) - px) ? i : best, 0);
    show();
  });
  const hide = () => { tooltip.hidden = true; cross.setAttribute('visibility', 'hidden'); point.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointerleave', hide); svg.addEventListener('blur', hide);
  svg.addEventListener('focus', show);
  svg.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); index = Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))); show();
  });
}

let disconnectChart;
export function showGameDetails(game, snapshot, profiles) { showDetails(game, snapshot, profiles); }
export function showAuthorDetails(data, snapshot, profiles, openGame) { showDetails(data.author, snapshot, profiles, { games: data.games, openGame }); }

function showDetails(game, snapshot, profiles, options) {
  disconnectChart?.();
  const isAuthor = Boolean(options);
  const dialog = document.querySelector('#game-detail');
  dialog.setAttribute('aria-label', `${game.name}统计`);
  dialog.replaceChildren();
  const header = node('div', 'dialog-header');
  const title = node('div', 'detail-title');
  title.append(portrait(isAuthor ? game.avatarUrl : game.iconUrl, game.name, isAuthor ? 'avatar author-portrait' : 'game-logo'));
  const text = node('div', 'detail-heading'); text.append(node('h2', '', game.name));
  const authors = node('div', 'authors-inline');
  (game.authorIds ?? []).forEach(id => { if (profiles.has(id)) authors.append(authorLink(profiles.get(id))); });
  if (isAuthor) authors.append(node('span', 'value-missing', `${game.gameCount} 款作品`));
  text.append(authors); title.append(text); header.append(title);
  const actions = node('div', 'dialog-actions');
  let mode = 'daily', days = 30;
  const download = iconButton('download', isAuthor ? '导出作者统计' : '导出游戏');
  download.addEventListener('click', async () => { const exports = await import('./export.js'); exports[isAuthor ? 'showAuthorExport' : 'showGameExport']({game, snapshot, profiles, mode, days}); });
  const tap = iconButton('external', '在 TapTap 查看');
  tap.addEventListener('click', () => window.open(isAuthor ? game.tapUrl : `https://www.taptap.cn/app/${game.appId}`, '_blank', 'noopener,noreferrer'));
  const close = iconButton('close', isAuthor ? '关闭作者统计' : '关闭游戏统计'); close.addEventListener('click', () => dialog.close());
  actions.append(download, tap, close); header.append(actions);
  const summary = node('div', 'detail-metrics');
  const history = game.history ?? [];
  for (const [key, label] of [['yesterday', '昨日'], ['month', '本月'], ['total', '总收益']]) {
    const card = node('div', 'detail-metric'); card.append(node('span', '', label));
    const amount = metricValue(game, key, snapshot);
    card.append(node('strong', '', typeof amount === 'number' ? money.format(amount) : '—'));
    const growth = periodGrowth(game, key, snapshot);
    if (growth !== null) card.append(node('small', growth > 0 ? 'positive' : growth < 0 ? 'negative' : '', `${growth > 0 ? '+' : ''}${growth.toFixed(1)}% ${key === 'month' ? '较上月同期' : '较前日'}`));
    if (isAuthor && amount === null) card.append(node('small', '', `${game.metricCounts[key]}/${game.gameCount} 款有数据`));
    summary.append(card);
  }
  const toolbar = node('div', 'chart-toolbar');
  const modes = node('div', 'tabs');
  const ranges = node('div', 'chart-ranges');
  const chart = node('div', 'chart');
  const draw = () => drawChart(chart, chartSeries(history, mode, days, game.asOf), mode);
  for (const [key, label] of [['daily', '每日'], ['cumulative', '累计']]) {
    const button = node('button', key === mode ? 'active' : '', label); button.type = 'button'; button.setAttribute('aria-pressed', String(key === mode));
    button.addEventListener('click', () => { mode = key; [...modes.children].forEach(item => { const selected = item === button; item.classList.toggle('active', selected); item.setAttribute('aria-pressed', String(selected)); }); draw(); });
    modes.append(button);
  }
  for (const [count, label] of [[30, '30天'], [90, '90天'], [0, '全部']]) {
    const button = node('button', count === days ? 'active' : '', label); button.type = 'button'; button.setAttribute('aria-pressed', String(count === days));
    button.addEventListener('click', () => { days = count; [...ranges.children].forEach(item => { const selected = item === button; item.classList.toggle('active', selected); item.setAttribute('aria-pressed', String(selected)); }); draw(); });
    ranges.append(button);
  }
  toolbar.append(modes, ranges);
  const footer = node('div', 'detail-footer');
  footer.append(node('span', '', '广告收益 · CNY'), node('span', '', game.asOf ? `截至 ${game.asOf}` : '待采集'));
  dialog.append(header, summary);
  if (isAuthor) dialog.append(node('p', 'scope-note', '本榜已收录作品广告收益 · 合作作品分别计入各作者；曲线仅展示各作品日报齐全的日期。'));
  dialog.append(toolbar, chart, footer);
  if (isAuthor) {
    const works = node('div', 'author-works'); works.append(node('h3', '', '本榜作品'));
    for (const work of options.games) {
      const button = node('button', 'author-work'); button.type = 'button';
      const label = node('span', 'game-cell'); label.append(portrait(work.iconUrl, work.name, 'game-logo'), node('span', '', work.name));
      const amount = metricValue(work, 'total', snapshot);
      button.append(label, node('span', 'numeric', amount === null ? '—' : money.format(amount)));
      button.title = `${work.name} · 累计广告收益`; button.addEventListener('click', () => options.openGame(work)); works.append(button);
    }
    dialog.append(works);
  }
  if (!dialog.open) dialog.showModal(); draw();
  let lastWidth = Math.round(chart.clientWidth);
  const observer = new ResizeObserver(entries => {
    const width = Math.round(entries[0].contentRect.width);
    if (width && width !== lastWidth) { lastWidth = width; draw(); }
  });
  observer.observe(chart);
  disconnectChart = () => observer.disconnect();
  dialog.addEventListener('close', disconnectChart, { once: true });
}

document.querySelector('#game-detail').addEventListener('click', event => {
  if (event.target !== event.currentTarget) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
});
