export const metricLabels = { yesterday: '昨日', month: '本月', total: '累计' };

export function fileName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 80).trim() || 'TapMoney';
}

export function periodLabel(snapshot, metric) {
  if (!snapshot.asOf) return '待采集';
  if (metric === 'yesterday') return snapshot.asOf;
  if (metric === 'month') return snapshot.monthStart > snapshot.asOf ? `${snapshot.monthStart} · 暂无完整日报` : `${snapshot.monthStart} — ${snapshot.asOf}`;
  return `截至 ${snapshot.asOf}`;
}

function csvCell(value) {
  let text = String(value ?? '');
  // 公开名称可能以公式字符开头；电子表格打开时按文本处理。
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function rankingCsv(rows, snapshot, metric, profiles, authorView = false) {
  const list = [['排名', authorView ? '作者 ID' : '游戏 ID', authorView ? '作者' : '游戏', authorView ? '作品数' : '作者', `${metricLabels[metric]}广告收益(CNY)`, '增长(%)', '统计日期', '统计起始日期']];
  for (const row of rows) list.push([row.rank ?? '', row.game.appId ?? row.game.id, row.game.name, authorView ? row.game.gameCount : (row.game.authorIds ?? []).map(id => profiles.get(id)?.name).filter(Boolean).join(' / '), row.amount ?? '', row.growth === null ? '' : Number(row.growth.toFixed(1)), row.game.asOf ?? '', metric === 'month' ? row.game.monthStart : metric === 'total' ? row.game.totalStartDate : row.game.asOf]);
  return '\ufeff' + list.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
