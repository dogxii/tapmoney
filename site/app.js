import { money, node, portrait, authorLink } from './ui.js';
import { showGameDetails } from './stats.js';
import { rankingUrl, adminEnabled } from './runtime.js';
import { metricValue, rankingRows, periodGrowth } from './data-utils.js';
const metrics = { yesterday: '昨日', month: '本月', total: '累计' };
const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
let snapshot;
let metric = 'yesterday';
let profiles = new Map();
let visibleRows = [];

function value(game, key) {
  return metricValue(game, key, snapshot);
}

function render() {
  if (!snapshot) return;
  const search = document.querySelector('#search').value.trim().toLocaleLowerCase();
  const selectedAuthor = document.querySelector('#author-select').value;
  visibleRows = rankingRows(snapshot.games, metric, snapshot).filter(({game}) => {
    const ids = game.authorIds ?? [];
    const names = ids.map(id => profiles.get(id)?.name ?? '').join(' ');
    return (!selectedAuthor || ids.includes(selectedAuthor)) && `${game.name} ${game.appId} ${names}`.toLocaleLowerCase().includes(search);
  });
  const visible = visibleRows.map(row => row.game);
  const tbody = document.querySelector('#games');
  tbody.replaceChildren();
  document.querySelectorAll('th.author-column').forEach(cell => { cell.hidden = profiles.size === 0; });
  for (const ranked of visibleRows) {
    const game = ranked.game;
    const row = node('tr');
    const rank = node('td', 'rank-column'); rank.append(node('span', '', ranked.rank ?? '—'));
    if (ranked.movement) {
      const change = node('small', ranked.movement > 0 ? 'positive rank-movement' : 'negative rank-movement', `${ranked.movement > 0 ? '↑' : '↓'}${Math.abs(ranked.movement)}`);
      change.title = `较前日${ranked.movement > 0 ? '上升' : '下降'} ${Math.abs(ranked.movement)} 名 · 当前已收录游戏`; rank.append(change);
    }
    row.append(rank);
    const gameCell = node('td', 'game-column');
    const detail = node('div', 'game-cell');
    detail.append(portrait(game.iconUrl, game.name, 'game-logo'));
    const text = node('div', 'game-text');
    const name = node('div', 'game-name');
    const link = node('button', 'game-open', game.name);
    link.type = 'button'; link.title = '查看游戏统计';
    link.addEventListener('click', () => showGameDetails(game, snapshot, profiles));
    row.classList.add('game-row');
    row.addEventListener('click', event => { if (!event.target.closest('a,button')) showGameDetails(game, snapshot, profiles); });
    name.append(link);
    if (game.status !== 'ok') {
      const indicator = node('span', `status-dot ${game.status === 'stale' ? 'stale' : 'unavailable'}`);
      indicator.title = game.status === 'stale' ? `历史数据 · 截至 ${game.asOf}` : game.status === 'pending' ? '待采集' : '暂无收益数据';
      indicator.setAttribute('role', 'img'); indicator.setAttribute('aria-label', indicator.title);
      name.append(indicator);
    }
    text.append(name);
    const authors = (game.authorIds ?? []).map(id => profiles.get(id)).filter(Boolean);
    const mobile = node('div', 'mobile-authors');
    authors.forEach(author => mobile.append(authorLink(author)));
    if (authors.length) text.append(mobile);
    detail.append(text); gameCell.append(detail); row.append(gameCell);
    if (profiles.size) {
      const authorCell = node('td', 'author-column');
      const group = node('div', 'authors-inline');
      authors.forEach(author => group.append(authorLink(author)));
      if (!authors.length) group.append(node('span', 'value-missing', '—'));
      authorCell.append(group); row.append(authorCell);
    }
    for (const key of Object.keys(metrics)) {
      const amount = value(game, key);
      const cell = node('td', `numeric${metric === key ? ' selected' : ''}${amount === null ? ' value-missing' : ''}`, amount === null ? '—' : money.format(amount));
      cell.title = `${metrics[key]}广告收益 · 截至 ${game.asOf ?? '暂无数据'}${key === 'total' ? ` · 起始 ${game.totalStartDate}` : ''}`;
      const growth = periodGrowth(game, key, snapshot);
      if (growth !== null) {
        const change = node('small', `revenue-growth ${growth > 0 ? 'positive' : growth < 0 ? 'negative' : ''}`, `${growth > 0 ? '+' : ''}${growth.toFixed(1)}%`);
        change.title = key === 'month' ? '较上月同期' : '较前日'; cell.append(change);
      }
      row.append(cell);
    }
    tbody.append(row);
  }
  document.querySelector('#empty').hidden = visible.length > 0;
  document.querySelector('#result-count').textContent = `${visible.length} 款`;
  const values = visible.map(game => value(game, metric)).filter(amount => amount !== null);
  const aggregate = document.querySelector('#aggregate');
  aggregate.textContent = values.length ? money.format(values.reduce((sum, amount) => sum + amount, 0)) : '—';
  aggregate.setAttribute('aria-label', `${metrics[metric]}收益合计 ${aggregate.textContent}`);
  document.querySelectorAll('[data-column]').forEach(column => {
    const selected = column.dataset.column === metric;
    column.classList.toggle('selected', selected);
    column.setAttribute('aria-sort', selected ? 'descending' : 'none');
  });
  const date = document.querySelector('#as-of');
  date.textContent = snapshot.asOf ? `截至 ${snapshot.asOf.slice(5).replace('-', '.')}` : '等待更新';
  date.title = snapshot.asOf ? `统计截至 ${snapshot.asOf} · 北京时间${metric === 'month' ? ` · 本月起始 ${snapshot.monthStart}` : ''}` : '等待首次收益采集';
}

function notice(message, error = false) {
  const element = document.querySelector('#notice');
  element.textContent = message; element.hidden = !message; element.classList.toggle('error', error);
}

document.querySelector('#search').addEventListener('input', render);
document.querySelector('#author-select').addEventListener('change', render);
document.querySelector('#export-ranking').addEventListener('click', async () => {
  if (!snapshot) return;
  const search = document.querySelector('#search').value.trim();
  const author = profiles.get(document.querySelector('#author-select').value)?.name;
  const options = { rows: visibleRows, snapshot, metric, profiles, filter: [search, author].filter(Boolean).join(' · ') };
  const { showRankingExport } = await import('./export.js');
  showRankingExport(options);
});
document.querySelectorAll('[data-metric]').forEach(button => button.addEventListener('click', () => {
  metric = button.dataset.metric;
  render();
}));

const themeButton = document.querySelector('#theme-toggle');
function syncTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeButton.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  themeButton.setAttribute('aria-label', dark ? '切换浅色主题' : '切换深色主题');
  themeButton.title = themeButton.getAttribute('aria-label');
}
themeButton.addEventListener('click', () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('tapmoney-theme', document.documentElement.dataset.theme); } catch { /* 存储不可用时仍可切换。 */ }
  syncTheme();
});
syncTheme();

async function load() {
  const button = document.querySelector('#refresh');
  button.disabled = true; button.classList.add('refreshing');
  try {
    let response = await fetch(rankingUrl, { cache: 'no-store' });
    if (!response.ok && adminEnabled) response = await fetch('./data/ranking.json', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.schemaVersion !== 1 || !Array.isArray(data.games)) throw new Error();
    snapshot = data;
    profiles = new Map((data.authors ?? []).map(author => [author.id, author]));
    const select = document.querySelector('#author-select');
    const selection = select.value;
    select.replaceChildren(node('option', '', '全部作者'));
    select.firstElementChild.value = '';
    for (const author of profiles.values()) { const option = node('option', '', author.name); option.value = author.id; select.append(option); }
    select.value = profiles.has(selection) ? selection : '';
    document.querySelector('#author-filter').hidden = profiles.size < 2;
    const updated = document.querySelector('#updated-at');
    const freshness = document.querySelector('#freshness');
    notice(''); freshness.className = 'status-dot';
    if (snapshot.generatedAt) {
      updated.textContent = dateTime.format(new Date(snapshot.generatedAt));
      updated.dateTime = snapshot.generatedAt; updated.title = '最近采集时间 · 北京时间';
      if (Date.now() - Date.parse(snapshot.generatedAt) > 36 * 3600000) { freshness.classList.add('stale'); notice('超过 36 小时未更新'); }
      else if (snapshot.games.some(game => game.status !== 'ok')) freshness.classList.add('stale');
    } else { updated.textContent = '—'; freshness.classList.add('unavailable'); }
    render();
  } catch { notice(snapshot ? '暂时无法刷新' : '暂时无法加载', true); }
  finally { button.disabled = false; button.classList.remove('refreshing'); }
}
document.querySelector('#refresh').addEventListener('click', load);
load();
if (adminEnabled) {
  document.querySelector('#manage-open').hidden = false;
  const { initAdmin } = await import('./admin.js');
  initAdmin({ onSaved: load });
}
