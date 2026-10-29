import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, json, readBody, badRequest, serveStatic, HttpError, unauthorized } from './http.js';
import { userFromRequest, cookie, renewSession } from './auth.js';
import { PaywallError } from './entitlements.js';
import { db } from './db.js';

import mountAuth from './api/auth.js';
import mountDocs from './api/documents.js';
import mountSigning from './api/signing.js';
import mountOrg from './api/org.js';
import mountBilling from './api/billing.js';
import mountAi from './api/ai.js';
import mountSaml from './api/saml.js';
import mountIntegrations from './api/integrations.js';

const PORT = Number(process.env.PORT || 4173);
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const router = new Router();
for (const mount of [mountAuth, mountDocs, mountSigning, mountOrg, mountBilling, mountAi, mountSaml, mountIntegrations]) mount(router);

// Password-unlock grants, keyed by session token, in memory only.
const unlocked = new Map();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (!path.startsWith('/api/')) {
    // SPA: routes fall back to the app shell, but a missing asset must 404
    // rather than quietly returning HTML with a 200.
    const looksLikeAsset = /\.[a-z0-9]{2,5}$/i.test(path);
    if (serveStatic(res, PUBLIC, path, { spa: looksLikeAsset ? null : 'index.html' })) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }

  const route = router.match(req.method, path);
  if (!route) return json(res, 404, { error: { message: `No route for ${req.method} ${path}` } });

  const token = cookie(req, 'dh_session')
    || (req.headers.authorization || '').replace(/^Bearer /, '') || null;
  const cookies = [];
  const ctx = {
    req, res, params: route.params, token,
    query: Object.fromEntries(url.searchParams),
    body: {},
    user: userFromRequest(req),
    signer: null,
    hijacked: false,
    rawBody: null,
    redirect(location) {
      res.writeHead(302, { location, ...(cookies.length ? { 'set-cookie': cookies } : {}) });
      res.end();
      this.hijacked = true;
    },
    unlocked: unlocked.get(token) || new Set(),
    unlock(docId) {
      if (!unlocked.has(token)) unlocked.set(token, new Set());
      unlocked.get(token).add(docId);
      this.unlocked = unlocked.get(token);
    },
    setCookie(c) { cookies.push(c); },
    requireUser() { if (!this.user) throw unauthorized(); return this.user; },
    raw(status, type, buf) {
      res.writeHead(status, { 'content-type': type, 'content-length': buf.length });
      res.end(buf);
      this.hijacked = true;
    },
  };

  if (ctx.user) {
    const renewed = renewSession(token);
    if (renewed) ctx.setCookie(renewed);
  }

  // A signer access token in the path authenticates that signer only.
  if (route.params.token) {
    ctx.signer = db.prepare(`SELECT s.*, sr.document_id FROM signers s
      JOIN sign_requests sr ON sr.id=s.sign_request_id WHERE s.access_token=?`).get(route.params.token) || null;
  }

  try {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      // The raw bytes are kept as well: the Stripe webhook signs them, and the
      // SAML ACS endpoint receives a form post rather than JSON.
      const buf = await readBody(req);
      ctx.rawBody = buf;
      const ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ctype === 'application/x-www-form-urlencoded') {
        ctx.body = Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
      } else if (buf.length) {
        try { ctx.body = JSON.parse(buf.toString('utf8')); }
        catch { throw badRequest('Malformed JSON body'); }
      }
    }
    const out = await route.handler(ctx);
    if (ctx.hijacked || res.headersSent) return;
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    const buf = Buffer.from(JSON.stringify(out ?? {}));
    headers['content-length'] = buf.length;
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(200, headers);
    res.end(buf);
  } catch (err) {
    if (res.headersSent) return;
    if (err instanceof PaywallError) {
      return json(res, 402, { error: {
        message: err.message, kind: 'paywall',
        feature: err.feature, required_plan: err.required_plan,
      } });
    }
    const status = err instanceof HttpError ? err.status : (err.status || 500);
    if (status >= 500) console.error(`${req.method} ${path}`, err);
    return json(res, status, { error: {
      message: status >= 500 ? 'Internal server error' : err.message,
      ...(err.password_required ? { password_required: true } : {}),
    } });
  }
});

server.listen(PORT, () => {
  console.log(`DocHub reconstruction listening on http://localhost:${PORT}`);
});
