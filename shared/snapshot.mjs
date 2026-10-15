import { normalizeConfig, profileId } from './catalog.mjs';
import { boardsOf, boardInfo } from './boards.mjs';
import { cleanMedia } from './media.mjs';

export function publicRanking(snapshot, config) {
  const oldBoards = boardsOf(snapshot);
  const old = new Map(oldBoards.map(board => [board.id, board]));
  const metadata = new Map(), profiles = new Map();
  for (const board of oldBoards) {
    for (const author of board.authors ?? []) {
      if (author.id === profileId(author.tapUrl) && (!profiles.has(author.id) || (author.metadataUpdatedAt ?? '') >= (profiles.get(author.id).metadataUpdatedAt ?? ''))) profiles.set(author.id, author);
    }
    for (const game of board.games ?? []) if (game.authorMode !== 'manual') {
      const previous = metadata.get(game.appId);
      if (!previous || (game.metadataUpdatedAt ?? '') > (previous.metadataUpdatedAt ?? '')) metadata.set(game.appId, game);
    }
  }
  return {
    schemaVersion: 2, generatedAt: snapshot.generatedAt ?? null, asOf: snapshot.asOf ?? null,
    monthStart: snapshot.monthStart ?? null, timezone: 'Asia/Shanghai', currency: 'CNY', source: 'TapTap 小游戏广告收益报表',
    boards: normalizeConfig(config).boards.map(board => ({ ...boardInfo(board), ...publicBoard(old.get(board.id) ?? {}, board, metadata, profiles) }))
  };
}

function publicBoard(snapshot, config, metadata, profiles) {
  const old = new Map((snapshot.games ?? []).map(game => [game.appId, game]));
  const games = config.games.map(game => {
    const saved = old.get(game.appId), official = metadata.get(game.appId);
    const matchingRange = saved?.totalStartDate === game.totalStartDate;
    const iconUrl = official?.iconUrl ?? game.iconUrl ?? null;
    return {
      appId: game.appId, name: official?.name || game.name, url: `https://www.taptap.cn/app/${game.appId}`, totalStartDate: game.totalStartDate,
      iconUrl,
      media: cleanMedia([...(iconUrl ? [{ kind: 'logo', url: iconUrl }] : []), ...(official?.media ?? []).filter(item => item.kind === 'screenshot')]),
      authorIds: [...new Set(official?.authorIds ?? [])].filter(id => profiles.has(id)), authorMode: 'auto',
      ...(official?.metadataUpdatedAt ? {metadataUpdatedAt: official.metadataUpdatedAt} : {}),
      status: saved?.status ?? 'pending', asOf: saved?.asOf ?? null, monthStart: saved?.monthStart ?? null,
      updatedAt: saved?.updatedAt ?? null,
      ...(saved?.lastAttemptAt ? { lastAttemptAt: saved.lastAttemptAt } : {}),
      revenue: { yesterday: saved?.revenue?.yesterday ?? null, month: saved?.revenue?.month ?? null, total: matchingRange ? saved?.revenue?.total ?? null : null },
      history: matchingRange ? saved?.history ?? [] : [],
      ...(matchingRange && saved?.previousRevenue ? {previousRevenue:saved.previousRevenue,growthBaseline:saved.growthBaseline} : {})
    };
  });
  const used = new Set(games.flatMap(game => game.authorIds));
  return { games, authors: [...profiles.values()].filter(author => used.has(author.id)).map(({ id, name, avatarUrl, tapUrl, metadataUpdatedAt }) => ({ id, name, avatarUrl, tapUrl, ...(metadataUpdatedAt ? {metadataUpdatedAt} : {}) })) };
}
