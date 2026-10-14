export function staticMediaUrl(value) {
  return typeof value === 'string' && /^\/media\/[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$/.test(value) ? value : null;
}

export function mediaUrl(value) {
  const local = staticMediaUrl(value);
  if (local) return local;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function cleanMedia(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.slice(0, 30).flatMap(item => {
    const url = mediaUrl(item?.url);
    if (!url || !['logo', 'screenshot'].includes(item.kind) || seen.has(url)) return [];
    seen.add(url);
    return [{ kind: item.kind, url }];
  });
}
