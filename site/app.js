import { money, node, portrait, authorLink, iconButton } from './ui.js';
import { adminEnabled } from './runtime.js';
import { loadRanking, loadGame } from './data-client.js';
import { metricValue, rankingRows, periodGrowth } from './data-utils.js';
import { boardsOf, validateBoards, boardAtPath, boardPath, boardSnapshot } from '../shared/boards.mjs';
const metrics = { yesterday: '昨日', month: '本月', total: '累计' };
const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
let snapshot;
let metric = 'yesterday';
let profiles = new Map();
let visibleRows = [];
let page = 0;
const pageSize = 100;
const rankings = new Map(), searchTerms = new Map();
let detailRequest = 0;
async function openGame(game) {
  const request = ++detailRequest;
  const dialog = document.querySelector('#game-detail');
  const header = node('div', 'dialog-header');
  const close = iconButton('close', '关闭游戏统计'); close.addEventListener('click', () => dialog.close());
  header.append(node('h2', '', game.name), close);
  dialog.setAttribute('aria-label', `${game.name}统计`); dialog.setAttribute('aria-busy', 'true');
  dialog.replaceChildren(header, node('div', 'empty', '加载中…'));
  if (!dialog.open) dialog.showModal();
  try {
    const [details, { showGameDetails }] = await Promise.all([loadGame(game, snapshot), import('./stats.js')]);
    if (request === detailRequest && dialog.open) showGameDetails(details, snapshot, profiles);
  } catch {
    if (request === detailRequest && dialog.open) {
      const retry = node('button', 'text-button', '重新加载'); retry.type = 'button';
      retry.addEventListener('click', () => { dialog.close(); openGame(game); });
      dialog.replaceChildren(header, node('div', 'empty', '暂时无法加载'), retry);
    }
  } finally { if (request === detailRequest) dialog.setAttribute('aria-busy', 'false'); }
}
document.querySelector('#board-select').addEventListener('change', event => { location.href = event.target.value; });

function value(game, key) {
  return metricValue(game, key, snapshot);
}

function render(resetPage = true) {
  if (!snapshot) return;
  if (resetPage) page = 0;
  const search = document.querySelector('#search').value.trim().toLocaleLowerCase();
  const selectedAuthor = document.querySelector('#author-select').value;
  if (!rankings.has(metric)) rankings.set(metric, rankingRows(snapshot.games, metric, snapshot));
  visibleRows = rankings.get(metric).filter(({game}) => {
    const ids = game.authorIds ?? [];
    return (!selectedAuthor || ids.includes(selectedAuthor)) && searchTerms.get(game.appId).includes(search);
  });
  const visible = visibleRows.map(row => row.game);
  const tbody = document.querySelector('#games');
  tbody.replaceChildren();
  const fragment = document.createDocumentFragment();
  const pages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  page = Math.min(page, pages - 1);
  document.querySelectorAll('th.author-column').forEach(cell => { cell.hidden = profiles.size === 0; });
  for (const ranked of visibleRows.slice(page * pageSize, (page + 1) * pageSize)) {
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
    link.addEventListener('click', () => openGame(game));
    row.classList.add('game-row');
    row.addEventListener('click', event => { if (!event.target.closest('a,button')) openGame(game); });
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
      cell.title = `${metrics[key]}广告收益 · 截至 ${game.asOf ?? '暂无数据'}${key === 'total' && game.totalStartDate ? ` · 起始 ${game.totalStartDate}` : ''}`;
      const growth = periodGrowth(game, key, snapshot);
      if (growth !== null) {
        const change = node('small', `revenue-growth ${growth > 0 ? 'positive' : growth < 0 ? 'negative' : ''}`, `${growth > 0 ? '+' : ''}${growth.toFixed(1)}%`);
        change.title = key === 'month' ? '较上月同期' : '较前日'; cell.append(change);
      }
      row.append(cell);
    }
    fragment.append(row);
  }
  tbody.append(fragment);
  document.querySelector('#pagination').hidden = pages < 2;
  document.querySelector('#page-position').textContent = `${page + 1} / ${pages}`;
  document.querySelector('#page-prev').disabled = page === 0;
  document.querySelector('#page-next').disabled = page === pages - 1;
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

let searchTimer;
document.querySelector('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => render(), 100); });
document.querySelector('#author-select').addEventListener('change', () => render());
for (const [id, step] of [['page-prev', -1], ['page-next', 1]]) document.querySelector(`#${id}`).addEventListener('click', () => {
  page += step; render(false); document.querySelector('.ranking').scrollIntoView({block: 'start'});
});
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

async function load(refresh = false) {
  const button = document.querySelector('#refresh');
  button.disabled = true; button.classList.add('refreshing');
  try {
    const data = await loadRanking(refresh);
    if (!(data.schemaVersion === 1 && Array.isArray(data.games) || data.schemaVersion === 2 && Array.isArray(data.boards))) throw new Error();
    const boards = validateBoards(boardsOf(data));
    if (boards.some(board => !Array.isArray(board.games) || !Array.isArray(board.authors))) throw new Error();
    const board = boardAtPath(boards, location.pathname);
    const navigation = document.querySelector('#board-select'); navigation.replaceChildren();
    for (const item of boards) { const option = node('option', '', item.name); option.value = boardPath(item); navigation.append(option); }
    navigation.hidden = boards.length < 2;
    if (!board) { const option = node('option', '', '选择榜单'); option.value = ''; option.disabled = true; navigation.prepend(option); }
    navigation.value = board ? boardPath(board) : '';
    document.querySelector('h1').textContent = board?.name ?? '榜单不存在';
    document.title = `TapMoney · ${board?.name ?? '榜单不存在'}`;
    document.querySelector('.ranking').hidden = !board;
    document.querySelector('.heading-tools').hidden = !board;
    document.querySelector('.as-of').hidden = !board;
    notice(''); snapshot = board ? boardSnapshot(data, board) : null;
    if (!snapshot) return;
    profiles = new Map(snapshot.authors.map(author => [author.id, author]));
    rankings.clear(); searchTerms.clear();
    for (const game of snapshot.games) searchTerms.set(game.appId, `${game.name} ${game.appId} ${(game.authorIds ?? []).map(id => profiles.get(id)?.name ?? '').join(' ')}`.toLocaleLowerCase());
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
  finally {
    button.disabled = false; button.classList.remove('refreshing');
    document.querySelector('.ranking').setAttribute('aria-busy', 'false');
    document.querySelector('#loading').hidden = true;
    document.querySelector('#export-ranking').disabled = !snapshot;
  }
}
document.querySelector('#refresh').addEventListener('click', () => load(true));
load();
if (adminEnabled) {
  const entry = document.querySelector('#manage-open'); entry.hidden = false;
  let admin;
  entry.addEventListener('click', async () => {
    entry.disabled = true;
    try {
      admin ??= import('./admin.js').then(({initAdmin}) => initAdmin({ getBoardId: () => snapshot?.id, onSaved: async path => { if (path) history.replaceState(null, '', path); await load(true); } }));
      const open = await admin; await open();
    } catch { admin = undefined; notice('暂时无法加载管理界面', true); }
    finally { entry.disabled = false; }
  });
}
