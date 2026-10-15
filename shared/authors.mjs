import { metricValue, previousValue, growthBaseline } from '../site/data-utils.js';

const metrics = ['yesterday', 'month', 'total'];
const rounded = value => Math.round(value * 100) / 100;
function completeSum(values) {
  return values.length && values.every(value => typeof value === 'number' && Number.isFinite(value)) ? rounded(values.reduce((sum, value) => sum + value, 0)) : null;
}

export function authorStats(profile, games, snapshot, { history = false } = {}) {
  // 同一作品在单个作者下只记一次；合作作品分别归属于各制作人。
  games = [...new Map(games.map(game => [game.appId, game])).values()];
  const revenue = {}, previousRevenue = {}, growth = {}, metricCounts = {};
  for (const key of metrics) {
    const values = games.map(game => game.asOf === snapshot.asOf ? metricValue(game, key, snapshot) : null);
    metricCounts[key] = values.filter(value => value !== null).length;
    revenue[key] = completeSum(values);
    previousRevenue[key] = completeSum(games.map(game => previousValue(game, key, snapshot)));
    const baseline = completeSum(games.map(game => growthBaseline(game, key, snapshot)));
    growth[key] = revenue[key] !== null && baseline !== null && baseline !== 0 ? (revenue[key] - baseline) / Math.abs(baseline) * 100 : null;
  }
  const dates = games.map(game => game.totalStartDate).filter(Boolean).sort();
  const result = { ...profile, gameIds: games.map(game => game.appId), gameCount: games.length,
    asOf: snapshot.asOf, monthStart: snapshot.monthStart, totalStartDate: dates[0] ?? null,
    revenue, previousRevenue, growth, metricCounts, status: metrics.every(key => metricCounts[key] === games.length) ? 'ok' : 'partial' };
  if (history) result.history = authorHistory(games);
  return result;
}

function authorHistory(games) {
  if (!games.length || games.some(game => !game.history?.length)) return [];
  const histories = games.map(game => {
    let total = 0;
    return new Map([...new Map(game.history.map(row => [row.date,row])).values()].sort((a,b) => a.date.localeCompare(b.date)).map(row => {
      total = rounded(total + row.revenue);
      return [row.date, { revenue: row.revenue, cumulativeRevenue: total }];
    }));
  });
  // 只展示每款作品均有日报的日期，不将未知日报补成零。
  return [...histories[0].keys()].filter(date => histories.every(rows => rows.has(date))).map(date => ({ date,
    revenue: completeSum(histories.map(rows => rows.get(date).revenue)),
    cumulativeRevenue: completeSum(histories.map(rows => rows.get(date).cumulativeRevenue))
  }));
}

export function authorsRanking(board, snapshot) {
  const assigned = new Map();
  for (const game of board.games) for (const id of new Set(game.authorIds ?? [])) {
    if (!assigned.has(id)) assigned.set(id, []);
    assigned.get(id).push(game);
  }
  return board.authors.filter(profile => assigned.has(profile.id)).map(profile => authorStats(profile, assigned.get(profile.id), snapshot));
}

export function authorDetails(snapshot, boardId, id) {
  const board = snapshot.boards.find(board => board.id === boardId);
  const profile = board?.authors.find(author => author.id === id);
  if (!profile) return null;
  const games = board.games.filter(game => game.authorIds?.includes(id));
  if (!games.length) return null;
  return { generatedAt: snapshot.generatedAt, author: authorStats(profile, games, snapshot, {history:true}),
    games: games.map(({appId,name,iconUrl,authorIds,status,asOf,monthStart,totalStartDate,revenue}) => ({appId,name,iconUrl,authorIds,status,asOf,monthStart,totalStartDate,revenue})) };
}
