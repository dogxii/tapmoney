const reserved = new Set(['api', 'data', 'media', 'shared', 'assets', 'index', 'favicon', '404']);

export function boardInfo(board) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(board.id ?? '')) throw new Error('榜单 ID 无效。');
  if (typeof board.name !== 'string' || !board.name.trim() || board.name.trim().length > 24) throw new Error('榜单名称需要填写 1–24 个字符。');
  const slug = board.slug;
  if (typeof slug !== 'string' || slug !== '' && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 48 || reserved.has(slug))) throw new Error('路径只能包含小写字母、数字和短横线，且不能使用保留路径。');
  return { id: board.id, name: board.name.trim(), slug };
}

export function validateBoards(boards) {
  if (!Array.isArray(boards) || !boards.length || boards.length > 20) throw new Error('需要保留 1–20 个榜单。');
  const ids = new Set(), slugs = new Set();
  for (const board of boards) {
    boardInfo(board);
    if (ids.has(board.id) || slugs.has(board.slug)) throw new Error('榜单 ID 和路径不能重复。');
    ids.add(board.id); slugs.add(board.slug);
  }
  if (!slugs.has('')) throw new Error('需要保留一个首页榜单。');
  return boards;
}

// 旧单榜配置与快照只迁移到首页，热门榜不继承其内容。
export function boardsOf(input) {
  return input.boards ?? [
    { id: 'home', name: '群友榜', slug: '', games: input.games ?? [], authors: input.authors ?? [] },
    { id: 'hot', name: '热门榜', slug: 'hot', games: [], authors: [] }
  ];
}

export const boardPath = board => board.slug ? `/${board.slug}` : '/';

export function boardAtPath(boards, pathname) {
  const path = pathname.replace(/\/$/, '') || '/';
  return boards.find(board => boardPath(board) === path) ?? null;
}

export function boardSnapshot(snapshot, board) {
  const { boards, ...common } = snapshot;
  return { ...common, ...board };
}
