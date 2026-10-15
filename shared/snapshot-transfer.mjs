import { boardsOf, boardInfo } from './boards.mjs';

// 每次只传一小份完整记录，Worker 无须同时解析、清洗整份历史快照。
export function snapshotTransfer(snapshot, targetBytes = 256 * 1024) {
  const encoder = new TextEncoder(), parts = [];
  const boards = boardsOf(snapshot).map(board => {
    const chunks = []; let chunk = { games: [], authors: [] }, bytes = 26;
    for (const field of ['games', 'authors']) for (const row of board[field] ?? []) {
      const size = encoder.encode(JSON.stringify(row)).length + 1;
      if (bytes + size > targetBytes && (chunk.games.length || chunk.authors.length)) {
        chunks.push(chunk); chunk = { games: [], authors: [] }; bytes = 26;
      }
      chunk[field].push(row); bytes += size;
    }
    if (chunk.games.length || chunk.authors.length || !chunks.length) chunks.push(chunk);
    chunks.forEach((body, part) => parts.push({ board: board.id, part, body }));
    return { ...boardInfo(board), parts: chunks.length, gameCount: board.games.length, authorCount: (board.authors ?? []).length };
  });
  return { metadata: { schemaVersion: 2, generatedAt: snapshot.generatedAt, asOf: snapshot.asOf, monthStart: snapshot.monthStart, boards }, parts };
}
