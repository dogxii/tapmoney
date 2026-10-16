import path from 'node:path';
import { cp, rm, readFile, readdir } from 'node:fs/promises';
import { ROOT, loadEnv, readJson, atomicWrite, isMain, printError } from './lib.mjs';
import { build as bundle } from 'esbuild';
import { rankingSummary, gameDetails, summaryPath } from '../shared/public-data.mjs';
import { boardsOf, boardPath } from '../shared/boards.mjs';
import { authorDetails } from '../shared/authors.mjs';

export const DEFAULT_PUBLIC_DATA_URL = 'https://cdn.jsdelivr.net/gh/dogxii/tapmoney@main/site/data/ranking.json';

export async function build({ env, snapshot, directory = path.join(ROOT, 'dist') } = {}) {
  env ??= await loadEnv();
  const rankingUrl = env.TAPMONEY_DATA_URL || DEFAULT_PUBLIC_DATA_URL;
  const url = new URL(rankingUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('TAPMONEY_DATA_URL 必须是公开 HTTPS 地址。');
  await rm(directory, { recursive: true, force: true });
  await cp(path.join(ROOT, 'site'), directory, { recursive: true });
  // Finder metadata is local workspace noise and must never be published.
  await rm(path.join(directory, '.DS_Store'), { force: true });
  await cp(path.join(ROOT, 'shared/boards.mjs'), path.join(directory, 'shared/boards.mjs'), { recursive: true });
  const runtime = `export const rankingUrl = ${JSON.stringify(rankingUrl)};\n`;
  await atomicWrite(path.join(directory, 'runtime.js'), runtime);
  const result = await bundle({ entryPoints: { app: path.join(ROOT, 'site/app.js'), styles: path.join(ROOT, 'site/styles.css') }, outdir: path.join(directory, 'assets'),
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, metafile: true, entryNames: '[name]-[hash]', chunkNames: '[name]-[hash]',
    plugins: [{name:'runtime', setup(build) {
      build.onResolve({filter:/^\.\/runtime\.js$/}, () => ({path:'runtime',namespace:'runtime'}));
      build.onLoad({filter:/^runtime$/,namespace:'runtime'}, () => ({contents:runtime,loader:'js'}));
    }}]
  });
  const output = entry => Object.entries(result.metafile.outputs).find(([,value]) => value.entryPoint === `site/${entry}` || value.entryPoint === path.join(ROOT, 'site', entry))?.[0];
  const asset = entry => '/' + path.relative(directory, output(entry)).split(path.sep).join('/');
  let html = await readFile(path.join(directory, 'index.html'), 'utf8');
  html = html.replace('href="/styles.css"', `href="${asset('styles.css')}"`).replace('src="/app.js"', `src="${asset('app.js')}"`);
  const appOutput = result.metafile.outputs[output('app.js')];
  for (const item of appOutput.imports.filter(item => item.kind === 'import-statement' && !item.external)) html = html.replace('</head>', `  <link rel="modulepreload" href="/${path.relative(directory, item.path).split(path.sep).join('/')}">\n</head>`);
  await atomicWrite(path.join(directory, 'index.html'), html);
  for (const filename of await readdir(path.join(ROOT, 'site'))) if (/\.(js|css)$/.test(filename) && filename !== 'runtime.js') await rm(path.join(directory, filename));
  snapshot ??= await readJson(path.join(ROOT, 'site/data/ranking.json'), {games:[],authors:[]});
  snapshot.schemaVersion = 2; snapshot.boards = boardsOf(snapshot);
  await atomicWrite(path.join(directory, 'data/ranking.json'), JSON.stringify(snapshot) + '\n');
  for (const board of snapshot.boards) {
    await atomicWrite(path.join(directory, summaryPath(boardPath(board))), JSON.stringify(rankingSummary(snapshot, boardPath(board))) + '\n');
    for (const game of board.games) if (game.status !== 'pending') await atomicWrite(path.join(directory, `data/games/${board.id}/${game.appId}.json`), JSON.stringify(gameDetails(snapshot, board.id, game.appId)) + '\n');
    for (const author of board.authors) {
      const detail = authorDetails(snapshot, board.id, author.id);
      if (detail) await atomicWrite(path.join(directory, `data/authors/${board.id}/${author.id}.json`), JSON.stringify(detail) + '\n');
    }
  }
  console.log('已构建纯静态站点。');
  return directory;
}

if (isMain(import.meta.url)) build().catch(printError);
