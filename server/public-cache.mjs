const policy = 'public, max-age=60, must-revalidate';

export async function cachedPublic(request, key, create, context) {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL(key, request.url), { method: 'GET' });
  const bypass = /no-cache|no-store/i.test(request.headers.get('Cache-Control') ?? '');
  let response;
  try { response = !bypass && cache ? await cache.match(cacheKey) : null; } catch { /* 缓存故障时仍可读取数据。 */ }
  if (!response) {
    response = await create();
    if (!response.ok) return response;
    const body = await response.text();
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const etag = '"' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') + '"';
    response = new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': policy, ETag: etag, 'X-Content-Type-Options': 'nosniff' } });
    if (cache) {
      const put = cache.put(cacheKey, response.clone()).catch(() => {});
      if (context?.waitUntil) context.waitUntil(put); else await put;
    }
  }
  const match = request.headers.get('If-None-Match');
  const unchanged = match?.split(',').some(value => value.trim().replace(/^W\//, '') === response.headers.get('ETag') || value.trim() === '*');
  return unchanged || request.method === 'HEAD' ? new Response(null, { status: unchanged ? 304 : 200, headers: response.headers }) : response;
}
