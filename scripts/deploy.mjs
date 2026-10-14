import { loadEnv, isMain, printError } from './lib.mjs';
import { build } from './build.mjs';
import { wrangler } from './cloud.mjs';

export async function deploy(env) {
  env ??= await loadEnv();
  const project = env.CLOUDFLARE_PAGES_PROJECT;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project ?? '')) throw new Error('请配置 CLOUDFLARE_PAGES_PROJECT。');
  const directory = await build({ env });
  await wrangler(['pages', 'deploy', directory, '--project-name', project, '--branch', 'main'], { env });
}

if (isMain(import.meta.url)) deploy().catch(printError);
