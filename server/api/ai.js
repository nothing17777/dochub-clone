import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { ask, TRANSFORMS, providerStatus, documentText } from '../ai.js';
import { entitlements, requireFeature, requireQuota, meter } from '../entitlements.js';
import { docFor } from './documents.js';
import { subscribe, DELIVERY_MODE, smtpStatus } from '../services.js';
import { STAMPS } from '../stamps.js';

export default function mount(r) {
  r.get('/api/v1/users/ai_chat_eligible', async (ctx) => {
    const u = ctx.requireUser();
    const ent = entitlements(u);
    return { eligible: !!ent.features.ai_basic, full_suite: !!ent.features.ai_full, ...providerStatus() };
  });

  r.get('/api/v1/ai-text-transformations', async () => ({
    transformations: Object.entries(TRANSFORMS).map(([id, prompt]) => ({ id, prompt })),
  }));

  r.post('/api/v1/document-assistant-messages', async (ctx) => {
    const u = ctx.requireUser();
    const doc = docFor(ctx, ctx.body.document_id);
    const res = await ask(u, {
      documentId: doc.id, threadId: ctx.body.thread_id,
      question: String(ctx.body.question || ''),
      transform: ctx.body.transform || null,
      pageText: ctx.body.page_text || '',
    });
    return res;
  });

  r.get('/api/v1/document-assistant-threads', async (ctx) => {
    const u = ctx.requireUser();
    const threads = db.prepare('SELECT * FROM ai_threads WHERE user_id=? AND document_id=? ORDER BY created_at DESC')
      .all(u.id, ctx.query.document_id || '');
    return { threads: threads.map((t) => ({
      ...t, messages: db.prepare('SELECT * FROM ai_messages WHERE thread_id=? ORDER BY created_at').all(t.id),
    })) };
  });

  r.get('/api/v1/ai-box-credits', async (ctx) => {
    const u = ctx.requireUser();
    const ent = entitlements(u);
    const cap = ent.limits.ai_messages;
    const used = Number(db.prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM usage_events WHERE user_id=? AND metric='ai_messages' AND period=?")
      .get(u.id, now().slice(0, 7)).n);
    return { credits: { used, limit: cap === Infinity ? null : cap } };
  });

  /** Semantic search over the user's documents. Lexical scoring: no embedding
   *  provider is configured, and the response says so. */
  r.get('/api/v1/documents/semantic-search-availability', async () => ({
    available: false, mode: 'lexical',
    note: 'No embedding provider configured; search falls back to lexical matching.',
  }));

  r.get('/api/v1/documents/search', async (ctx) => {
    const u = ctx.requireUser();
    const q = String(ctx.query.q || '').trim();
    if (!q) return { results: [] };
    const docs = db.prepare(`SELECT DISTINCT d.* FROM documents d LEFT JOIN document_roles dr ON dr.document_id=d.id
      WHERE (d.owner_id=? OR dr.user_id=?) AND d.state<>'trashed'`).all(u.id, u.id);
    const terms = q.toLowerCase().split(/\s+/);
    const results = docs.map((d) => {
      const hay = `${d.title}\n${documentText(d.id)}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { document: { id: d.id, title: d.title, updated_at: d.updated_at }, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 25);
    return { results, mode: 'lexical' };
  });

  // --- stamps -------------------------------------------------------------
  r.get('/api/v1/stamps', async (ctx) => {
    const u = ctx.requireUser();
    const custom = db.prepare('SELECT * FROM stamps WHERE owner_id=?').all(u.id);
    return { stamps: [...STAMPS, ...custom], categories: [...new Set(STAMPS.map((s) => s.category))] };
  });

  r.post('/api/v1/stamps', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'stamps');
    const id = randomUUID();
    db.prepare('INSERT INTO stamps (id,owner_id,name,category,svg,builtin) VALUES (?,?,?,?,?,0)')
      .run(id, u.id, ctx.body.name || 'Stamp', ctx.body.category || 'custom', String(ctx.body.svg || ''));
    return { stamp: db.prepare('SELECT * FROM stamps WHERE id=?').get(id) };
  });

  r.get('/api/v1/google-fonts/catalog', async () => ({
    fonts: ['Helvetica', 'Times New Roman', 'Courier', 'Arial', 'Georgia', 'Verdana',
            'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Source Sans 3',
            'Caveat', 'Dancing Script', 'Great Vibes', 'Satisfy'],
  }));

  // --- realtime (stands in for ActionCable) ------------------------------
  r.get('/api/cable', async (ctx) => {
    const u = ctx.requireUser();
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    });
    ctx.res.write(`event: ready\ndata: ${JSON.stringify({ user_id: u.id })}\n\n`);
    subscribe(ctx.res, { userId: u.id, documentId: ctx.query.document_id || null });
    const ping = setInterval(() => { try { ctx.res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25000);
    ctx.res.on('close', () => clearInterval(ping));
    ctx.hijacked = true;
    return null;
  });

  // --- export tasks -------------------------------------------------------
  r.post('/api/v1/export-tasks', async (ctx) => {
    const u = ctx.requireUser();
    const doc = docFor(ctx, ctx.body.document_id);
    const kind = String(ctx.body.kind || 'pdf');
    const cloud = ['drive', 'dropbox', 'onedrive', 'gmail'];
    const id = randomUUID();
    if (cloud.includes(kind)) {
      db.prepare(`INSERT INTO export_tasks (id,user_id,document_id,kind,state,error,created_at,finished_at)
                  VALUES (?,?,?,?,'failed','provider_not_connected',?,?)`)
        .run(id, u.id, doc.id, kind, now(), now());
      throw badRequest(`${kind} export needs that integration connected first`);
    }
    // pdf / docx / audit / field_values are produced in the browser or inline.
    db.prepare(`INSERT INTO export_tasks (id,user_id,document_id,kind,state,created_at,finished_at)
                VALUES (?,?,?,?,'succeeded',?,?)`).run(id, u.id, doc.id, kind, now(), now());
    if (kind === 'field_values') {
      const fields = db.prepare('SELECT name,type,value FROM formfields WHERE document_id=?').all(doc.id);
      const csv = ['name,type,value', ...fields.map((f) =>
        [f.name, f.type, f.value].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
      return { task_id: id, state: 'succeeded', kind, filename: `${doc.title}-fields.csv`, content: csv };
    }
    if (kind === 'audit') {
      const acts = db.prepare('SELECT * FROM document_activities WHERE document_id=? ORDER BY created_at').all(doc.id);
      return { task_id: id, state: 'succeeded', kind, filename: `${doc.title}-audit.json`,
               content: JSON.stringify({ document: doc.title, certificate_hash: doc.certificate_hash,
                                         activities: acts }, null, 2) };
    }
    return { task_id: id, state: 'succeeded', kind,
             note: kind === 'pdf' ? 'Flattened PDF is composed in the browser from the stored annotations.'
                                  : 'DOCX conversion is not implemented in this build.' };
  });

  r.get('/api/v1/export-tasks', async (ctx) => {
    const u = ctx.requireUser();
    return { export_tasks: db.prepare('SELECT * FROM export_tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(u.id) };
  });

  r.get('/api/v1/email-records', async (ctx) => {
    const u = ctx.requireUser();
    return {
      email_records: db.prepare('SELECT * FROM email_records WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(u.id),
      delivery: { mode: DELIVERY_MODE, ...smtpStatus() },
    };
  });
}
