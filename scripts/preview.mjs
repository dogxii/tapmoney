import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const site = path.join(ROOT, process.argv.includes('--built') ? 'dist' : 'site');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const page = pathname === '/' || /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(pathname) && !['/api', '/data', '/media', '/shared'].includes(pathname.replace(/\/$/, ''));
    const target = path.resolve(site, `.${page ? '/index.html' : pathname}`);
    if (!target.startsWith(site + path.sep)) { response.writeHead(403).end(); return; }
    const content = /^\/shared\/[a-z-]+\.mjs$/.test(pathname) && !process.argv.includes('--built') ? await readFile(path.join(ROOT, pathname.slice(1))) : await readFile(target);
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch { if (!response.headersSent) response.writeHead(404); response.end('Not found'); }
});
const port = Number(process.env.PORT ?? 4173);
server.listen(port, '127.0.0.1', () => console.log(`本地预览：http://127.0.0.1:${port}`));
