import path from 'node:path';
import { ROOT, readJson } from './lib.mjs';
import { normalizeConfig } from '../shared/catalog.mjs';

export async function loadConfig() {
  const saved = await readJson(path.join(ROOT, 'config/boards.json'));
  return normalizeConfig(saved ?? {
    games: await readJson(path.join(ROOT, 'config/games.json'), []),
    authors: await readJson(path.join(ROOT, 'config/authors.json'), [])
  });
}
