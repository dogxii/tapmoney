export function validId(value, label) {
  if (!/^\d+$/.test(String(value ?? ''))) throw new Error(`${label} 必须是数字 ID。`);
  return String(value);
}

export function imageUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeGames(list) {
  if (!Array.isArray(list) || list.length > 500) throw new Error('游戏列表最多支持 500 款。');
  const ids = new Set();
  return list.map(item => {
    const appId = validId(item.appId, 'appId');
    if (appId.length > 16 || ids.has(appId)) throw new Error('游戏 ID 无效或重复。');
    ids.add(appId);
    if (typeof item.name !== 'string' || !item.name.trim()) throw new Error(`游戏 ${appId} 缺少名称。`);
    const totalStartDate = item.totalStartDate || '2020-01-01';
    if (!validDate(totalStartDate)) throw new Error(`游戏 ${appId} 的累计起始日期无效。`);
    const iconUrl = imageUrl(item.iconUrl);
    if (item.iconUrl && !iconUrl) throw new Error(`游戏 ${appId} 的 Logo 必须是 HTTPS 链接。`);
    return { appId, name: item.name.trim().slice(0,128), totalStartDate,
      ...(iconUrl ? {iconUrl} : {}),
      ...(item.queryDeveloperId ? {queryDeveloperId:validId(item.queryDeveloperId, 'queryDeveloperId')} : {}) };
  });
}
export function configSource(env) {
  const source = env.TAPMONEY_CONFIG_SOURCE || 'repository';
  if (!['repository', 'cloud'].includes(source)) throw new Error('TAPMONEY_CONFIG_SOURCE 只能是 repository 或 cloud。');
  return source;
}

