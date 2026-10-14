export function dailyGrowth(history, date) {
  const today = history.find(row => row.date === date);
  const previousDate = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(previousDate.valueOf()) || !today) return null;
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  const previous = history.find(row => row.date === previousDate.toISOString().slice(0, 10));
  if (!previous || previous.revenue === 0) return null;
  return (today.revenue - previous.revenue) / Math.abs(previous.revenue) * 100;
}

export function chartSeries(history, mode, days, asOf) {
  let total = 0;
  const rows = [...history].sort((a, b) => a.date.localeCompare(b.date)).map(row => {
    total = Math.round((total + row.revenue) * 100) / 100;
    return { date: row.date, revenue: mode === 'cumulative' ? total : row.revenue };
  });
  if (!days || !asOf) return rows;
  const start = new Date(`${asOf}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const boundary = start.toISOString().slice(0, 10);
  return rows.filter(row => row.date >= boundary && row.date <= asOf);
}

export function chartSegments(points, mode) {
  const segments = [];
  for (const point of points) {
    const current = segments.at(-1);
    if (!current || (mode === 'daily' && Date.parse(point.date) - Date.parse(current.at(-1).date) > 86400000)) segments.push([point]);
    else current.push(point);
  }
  return segments;
}

export function metricValue(game, key, snapshot) {
  if (key !== 'total' && game.asOf !== snapshot.asOf) return null;
  if (key === 'month' && game.monthStart !== snapshot.monthStart) return null;
  const amount = game.revenue?.[key];
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
}

export function dayBefore(date) {
  const time = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(time.valueOf())) return null;
  time.setUTCDate(time.getUTCDate() - 1);
  return time.toISOString().slice(0, 10);
}

function percent(current, baseline) {
  return typeof current === 'number' && typeof baseline === 'number' && baseline !== 0 ? (current - baseline) / Math.abs(baseline) * 100 : null;
}

export function periodGrowth(game, metric, snapshot) {
  if (game.growth) return game.growth[metric] ?? null;
  const current = metricValue(game, metric, snapshot);
  if (current === null || !snapshot.asOf) return null;
  if (metric === 'yesterday') return dailyGrowth(game.history ?? [], snapshot.asOf);
  if (metric === 'total') return percent(current, previousValue(game, metric, snapshot));
  // 本月与上月相同天数比较，完整的上月同期日报是必要条件。
  if (snapshot.asOf.slice(0, 7) !== snapshot.monthStart?.slice(0, 7)) return null;
  const previousMonth = new Date(`${snapshot.monthStart}T12:00:00Z`);
  previousMonth.setUTCDate(0);
  const count = Number(snapshot.asOf.slice(8));
  if (count > previousMonth.getUTCDate()) return null;
  const start = `${previousMonth.toISOString().slice(0, 7)}-01`;
  if (game.totalStartDate > start) return null;
  let sum = 0;
  const rows = new Map((game.history ?? []).map(row => [row.date, row.revenue]));
  for (let day = 1; day <= count; day++) {
    const amount = rows.get(`${start.slice(0, 8)}${String(day).padStart(2, '0')}`);
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
    sum += amount;
  }
  return percent(current, sum);
}

export function previousValue(game, metric, snapshot) {
  if (game.previousRevenue) return game.previousRevenue[metric] ?? null;
  const current = metricValue(game, metric, snapshot);
  if (current === null || game.asOf !== snapshot.asOf) return null;
  const before = dayBefore(snapshot.asOf);
  const rows = game.history ?? [];
  const previous = rows.find(row => row.date === before);
  if (!previous || !Number.isFinite(previous.revenue)) return null;
  if (metric === 'yesterday') return previous.revenue;
  if (metric === 'month' && before?.slice(0, 7) !== snapshot.monthStart?.slice(0, 7)) return null;
  const daily = rows.find(row => row.date === snapshot.asOf);
  return daily && Number.isFinite(daily.revenue) ? Math.round((current - daily.revenue) * 100) / 100 : null;
}

export function rankingRows(games, metric, snapshot) {
  const compare = (a, b) => b.amount - a.amount || a.game.appId.localeCompare(b.game.appId);
  const rows = games.map(game => ({ game, amount: metricValue(game, metric, snapshot), rank: null, movement: null, growth: periodGrowth(game, metric, snapshot) }));
  const eligible = rows.filter(row => row.amount !== null).sort(compare);
  eligible.forEach((row, index) => { row.rank = index + 1; });
  const previous = eligible.map(row => ({ game: row.game, amount: previousValue(row.game, metric, snapshot) }));
  // 任一游戏缺少基准时不推算名次变化；使用相同的已收录游戏集合比较。
  if (previous.length && previous.every(row => row.amount !== null)) {
    previous.sort(compare);
    const ranks = new Map(previous.map((row, index) => [row.game.appId, index + 1]));
    eligible.forEach(row => { row.movement = ranks.get(row.game.appId) - row.rank; });
  }
  return [...eligible, ...rows.filter(row => row.amount === null).sort((a, b) => a.game.appId.localeCompare(b.game.appId))];
}
