import { boardInfo, boardAtPath } from './boards.mjs';
import { periodGrowth, previousValue } from '../site/data-utils.js';

export function rankingSummary(snapshot, pathname) {
  const selected = boardAtPath(snapshot.boards, pathname);
  const { boards, games, authors, revision, ...common } = snapshot;
  return { ...common, summary: true, boards: boards.map(board => ({
    ...boardInfo(board), authors: board === selected ? board.authors : [],
    games: board !== selected ? [] : board.games.map(game => {
      const revenue = Object.fromEntries(Object.entries(game.revenue ?? {}).filter(([,value]) => typeof value === 'number'));
      const metrics = ['yesterday', 'month', 'total'];
      return {
        appId: game.appId, name: game.name, iconUrl: game.iconUrl,
        ...(game.authorIds?.length ? { authorIds: game.authorIds } : {}),
        status: game.status,
        ...(game.asOf ? { asOf: game.asOf, monthStart: game.monthStart, totalStartDate: game.totalStartDate, revenue,
          growth: Object.fromEntries(metrics.map(key => [key, periodGrowth(game, key, snapshot)])),
          previousRevenue: Object.fromEntries(metrics.map(key => [key, previousValue(game, key, snapshot)]))
        } : {})
      };
    })
  })) };
}

export function gameDetails(snapshot, boardId, appId) {
  const board = snapshot.boards.find(board => board.id === boardId);
  const game = board?.games.find(game => game.appId === appId);
  return game ? { generatedAt: snapshot.generatedAt, game } : null;
}

export const summaryPath = pathname => `/data/boards/${pathname.replace(/^\/+|\/+$/g, '') || 'index'}.json`;
