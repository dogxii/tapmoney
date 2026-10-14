import { normalizeConfig, normalizeAuthors } from './catalog.mjs';
import { boardsOf, boardInfo } from './boards.mjs';
import { cleanMedia } from './media.mjs';

export function publicRanking(snapshot, config) {
  const old = new Map(boardsOf(snapshot).map(board => [board.id, board]));
  return {
    schemaVersion: 2, generatedAt: snapshot.generatedAt ?? null, asOf: snapshot.asOf ?? null,
    monthStart: snapshot.monthStart ?? null, timezone: 'Asia/Shanghai', currency: 'CNY', source: 'TapTap 小游戏广告收益报表',
    boards: normalizeConfig(config).boards.map(board => ({ ...boardInfo(board), ...publicBoard(old.get(board.id) ?? {}, board) }))
  };
}

function publicBoard(snapshot, config) {
  const old = new Map((snapshot.games ?? []).map(game => [game.appId, game]));
  const profiles = new Map((snapshot.authors ?? []).map(author => [author.id, author]));
  const authors = normalizeAuthors(config.authors);
  const games = config.games.map(game => {
    const saved = old.get(game.appId);
    const bound = authors.filter(author => author.gameIds.includes(game.appId));
    for (const author of bound) {
      const cached = profiles.get(author.id);
      profiles.set(author.id, { ...author, avatarUrl: cached?.avatarSourceUrl === author.avatarUrl ? cached.avatarUrl : author.avatarUrl, avatarSourceUrl: author.avatarUrl });
    }
    const matchingRange = saved?.totalStartDate === game.totalStartDate;
    const iconUrl = game.iconUrl && game.iconUrl !== saved?.iconSourceUrl ? game.iconUrl : saved?.iconUrl ?? game.iconUrl ?? null;
    return {
      appId: game.appId, name: game.name, url: `https://www.taptap.cn/app/${game.appId}`, totalStartDate: game.totalStartDate,
      iconUrl, iconSourceUrl: game.iconUrl ?? saved?.iconSourceUrl ?? null,
      media: cleanMedia([...(iconUrl ? [{ kind: 'logo', url: iconUrl }] : []), ...(saved?.media ?? []).filter(item => item.kind === 'screenshot')]),
      authorIds: bound.length ? bound.map(author => author.id) : saved?.authorMode === 'manual' ? [] : saved?.authorIds ?? [],
      authorMode: bound.length ? 'manual' : 'auto',
      status: saved?.status ?? 'pending', asOf: saved?.asOf ?? null, monthStart: saved?.monthStart ?? null,
      updatedAt: saved?.updatedAt ?? null,
      ...(saved?.lastAttemptAt ? { lastAttemptAt: saved.lastAttemptAt } : {}),
      revenue: { yesterday: saved?.revenue?.yesterday ?? null, month: saved?.revenue?.month ?? null, total: matchingRange ? saved?.revenue?.total ?? null : null },
      history: matchingRange ? saved?.history ?? [] : []
    };
  });
  const used = new Set(games.flatMap(game => game.authorIds));
  return {
    games,
    authors: [...profiles.values()].filter(author => used.has(author.id)).map(({ id, name, avatarUrl, avatarSourceUrl, tapUrl }) => ({ id, name, avatarUrl, avatarSourceUrl, tapUrl }))
  };
}

