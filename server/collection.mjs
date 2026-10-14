const active = new Set(['requested', 'queued', 'in_progress', 'waiting', 'pending']);
const cooldownMs = 60_000;

function settings(env) {
  const repository = env.COLLECT_REPOSITORY;
  return /^[\w-]+\/[\w.-]+$/.test(repository ?? '') && env.COLLECT_TOKEN ? { repository, token: env.COLLECT_TOKEN } : null;
}

async function github(env, route, { request, method = 'GET', body } = {}) {
  const { repository, token } = settings(env);
  let response;
  try {
    response = await request(`https://api.github.com/repos/${repository}/actions/workflows/collect.yml/${route}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TapMoney' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), redirect: 'error'
    });
  } catch { throw new Error('暂时无法连接采集任务，请稍后重试。'); }
  if (!response.ok) {
    if ([401, 403, 404].includes(response.status)) throw new Error('GitHub 采集凭证已失效或缺少仓库 Actions 读写权限。');
    throw new Error('GitHub 暂时无法处理采集任务，请稍后重试。');
  }
  return response.status === 204 ? null : response.json();
}

async function state(env, { request, now }) {
  const { repository } = settings(env);
  const [data, saved] = await Promise.all([
    github(env, 'runs?branch=main&per_page=1', { request }),
    env.DB.prepare('SELECT body, updated_at FROM documents WHERE key = ?').bind('collection').first()
  ]);
  const run = data.workflow_runs?.[0];
  const requestedAt = saved ? JSON.parse(saved.body).requestedAt : null;
  const pending = requestedAt && now.getTime() - Date.parse(requestedAt) < cooldownMs && (!run || Date.parse(run.created_at) < Date.parse(requestedAt) - 1000);
  const id = Number.isSafeInteger(run?.id) && run.id > 0 ? run.id : null;
  return {
    enabled: true, status: pending ? 'requested' : run?.status ?? 'idle',
    runId: pending ? null : id, conclusion: pending ? null : run?.conclusion ?? null,
    requestedAt, nextAllowedAt: requestedAt ? new Date(Date.parse(requestedAt) + cooldownMs).toISOString() : null,
    url: `https://github.com/${repository}/actions/${pending || !id ? 'workflows/collect.yml' : `runs/${id}`}`
  };
}

export async function collectionStatus(env, { request = fetch, now = new Date() } = {}) {
  if (!settings(env)) return { enabled: false, status: 'unconfigured' };
  return state(env, { request, now });
}

export async function dispatchCollection(env, { request = fetch, now = new Date() } = {}) {
  if (!settings(env)) throw new Error('尚未配置手动采集，请设置 Pages 的 COLLECT_REPOSITORY 和 COLLECT_TOKEN。');
  const current = await state(env, { request, now });
  if (active.has(current.status)) return current;
  const requestedAt = now.toISOString();
  // 原子预留防止多标签页同时派发；已排队的 Actions 任务也会被上面的状态检查复用。
  const reserved = await env.DB.prepare("INSERT INTO documents (key, body, revision, updated_at) VALUES ('collection', ?, 1, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, revision = documents.revision + 1, updated_at = excluded.updated_at WHERE documents.updated_at <= ?")
    .bind(JSON.stringify({ requestedAt }), requestedAt, new Date(now.getTime() - cooldownMs).toISOString()).run();
  if (reserved.meta.changes !== 1) return state(env, { request, now });
  await github(env, 'dispatches', { request, method: 'POST', body: { ref: 'main' } });
  return { ...current, status: 'requested', runId: null, conclusion: null, requestedAt, nextAllowedAt: new Date(now.getTime() + cooldownMs).toISOString(), url: `https://github.com/${settings(env).repository}/actions/workflows/collect.yml` };
}
