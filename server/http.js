// Minimal router + helpers. No external dependencies: `node server/index.js` runs as-is.
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.ico': 'image/x-icon', '.map': 'application/json',
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
export const badRequest = (m) => new HttpError(400, m);
export const unauthorized = (m = 'Authentication required') => new HttpError(401, m);
export const forbidden = (m = 'Not permitted') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);

export function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

export async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Payload too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw badRequest('Malformed JSON body'); }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const names = [];
    const rx = new RegExp('^' + pattern.replace(/:[A-Za-z_]+/g, (m) => {
      names.push(m.slice(1));
      return '([^/]+)';
    }).replace(/\*/g, '.*') + '$');
    this.routes.push({ method, rx, names, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }
  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(path);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}

export function serveStatic(res, rootDir, urlPath, { spa = null } = {}) {
  let rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '\\') rel = '/index.html';
  let file = join(rootDir, rel);
  let st;
  try { st = statSync(file); if (st.isDirectory()) { file = join(file, 'index.html'); st = statSync(file); } }
  catch {
    if (!spa) return false;
    file = join(rootDir, spa);
    try { st = statSync(file); } catch { return false; }
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}
