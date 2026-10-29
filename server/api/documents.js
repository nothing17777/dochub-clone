import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, now, BLOB_DIR } from '../db.js';
import { badRequest, notFound, forbidden, HttpError } from '../http.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { requireFeature, requireQuota, requireCountUnder, meter, entitlements } from '../entitlements.js';
import { logActivity, publish, notify, sendEmail } from '../services.js';

const MARKUP_ADVANCED = new Set(['whiteout', 'stamp']);

export function docFor(ctx, id, { write = false } = {}) {
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(id);
  if (!doc) throw notFound('Document not found');
  const u = ctx.user;
  if (u && doc.owner_id === u.id) return doc;
  const role = u && db.prepare('SELECT * FROM document_roles WHERE document_id=? AND (user_id=? OR email=?)')
    .get(id, u.id, u.email);
  if (role && (!write || role.role !== 'viewer')) return doc;
  // signer access token path
  if (ctx.signer && ctx.signer.document_id === id) return doc;
  throw forbidden('You do not have access to this document');
}

const pagesOf = (id) => db.prepare('SELECT * FROM pages WHERE document_id=? AND deleted=0 ORDER BY position').all(id);

export function serializeDoc(doc) {
  return {
    ...doc,
    is_template: !!doc.is_template, is_private: !!doc.is_private,
    password_protected: !!doc.password_hash,
    password_hash: undefined, 
    pages: pagesOf(doc.id),
    labels: db.prepare(`SELECT l.* FROM doc_labels l JOIN document_doc_labels m ON m.doc_label_id=l.id
                        WHERE m.document_id=?`).all(doc.id),
    roles: db.prepare('SELECT id,email,role,state,created_at FROM document_roles WHERE document_id=?').all(doc.id),
  };
}

function createDocument(user, { title, sourceId = null, pageCount = 1, isTemplate = 0, folderId = null, pageSizes = null }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO documents (id,owner_id,organization_id,source_id,folder_id,title,state,is_template,page_count,created_at,updated_at)
              VALUES (?,?,?,?,?,?,'draft',?,?,?,?)`)
    .run(id, user.id, user.organization_id, sourceId, folderId, title || 'Untitled', isTemplate, pageCount, now(), now());
  const ins = db.prepare(`INSERT INTO pages (id,document_id,position,source_page_index,width,height,blank)
                          VALUES (?,?,?,?,?,?,?)`);
  for (let i = 0; i < pageCount; i++) {
    const size = pageSizes?.[i] || { width: 612, height: 792 };
    ins.run(randomUUID(), id, i, sourceId ? i : null, size.width, size.height, sourceId ? 0 : 1);
  }
  logActivity(id, { actorId: user.id, actorEmail: user.email, action: 'document.created', detail: { title } });
  return db.prepare('SELECT * FROM documents WHERE id=?').get(id);
}

export default function mount(r) {
  // --- sources / upload ---------------------------------------------------
  r.post('/api/v1/s3-direct', async (ctx) => {
    // The production app uploads to S3 and then posts a fingerprint. Here the
    // bytes are stored locally under data/blobs and keyed by SHA-256.
    const u = ctx.requireUser();
    const { filename = 'upload.pdf', mime = 'application/pdf', data_base64 } = ctx.body;
    if (!data_base64) throw badRequest('data_base64 is required');
    const buf = Buffer.from(data_base64, 'base64');
    if (!buf.length) throw badRequest('Empty upload');
    const sha = createHash('sha256').update(buf).digest('hex');
    const rel = `${sha}.bin`;
    writeFileSync(join(BLOB_DIR, rel), buf);
    const id = randomUUID();
    db.prepare(`INSERT INTO sources (id,owner_id,kind,filename,mime,byte_size,sha256,blob_path,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, u.id, 'file', filename, mime, buf.length, sha, rel, now());
    return { source: db.prepare('SELECT * FROM sources WHERE id=?').get(id) };
  });

  r.get('/api/v1/sources/:id/blob', async (ctx) => {
    const u = ctx.requireUser();
    const s = db.prepare('SELECT * FROM sources WHERE id=?').get(ctx.params.id);
    if (!s) throw notFound('Source not found');
    const shared = db.prepare(`SELECT 1 FROM documents d LEFT JOIN document_roles dr ON dr.document_id=d.id
                               WHERE d.source_id=? AND (d.owner_id=? OR dr.user_id=? OR dr.email=?)`)
      .get(s.id, u.id, u.id, u.email);
    if (s.owner_id !== u.id && !shared && !ctx.signer) throw forbidden();
    const p = join(BLOB_DIR, s.blob_path);
    if (!existsSync(p)) throw notFound('Blob missing');
    ctx.raw(200, s.mime, readFileSync(p));
    return null;
  });

  // --- document creation --------------------------------------------------
  r.post('/api/v1/documents/create-with-source', async (ctx) => {
    const u = ctx.requireUser();
    const { source_id, title, page_count = 1, folder_id = null, page_sizes = null } = ctx.body;
    const src = db.prepare('SELECT * FROM sources WHERE id=? AND owner_id=?').get(source_id, u.id);
    if (!src) throw notFound('Source not found');
    const doc = createDocument(u, {
      title: title || src.filename.replace(/\.[a-z0-9]+$/i, ''),
      sourceId: source_id, pageCount: Math.max(1, Number(page_count) || 1),
      folderId: folder_id, pageSizes: page_sizes,
    });
    return { document: serializeDoc(doc) };
  });

  r.post('/api/v1/documents/create-blank', async (ctx) => {
    const u = ctx.requireUser();
    const doc = createDocument(u, { title: ctx.body.title || 'Blank document', pageCount: Number(ctx.body.page_count) || 1 });
    return { document: serializeDoc(doc) };
  });

  r.post('/api/v1/documents/create-with-template', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'templates');
    const tpl = db.prepare('SELECT * FROM documents WHERE id=? AND is_template=1').get(ctx.body.template_id);
    if (!tpl) throw notFound('Template not found');
    const doc = createDocument(u, { title: ctx.body.title || tpl.title, sourceId: tpl.source_id, pageCount: tpl.page_count });
    // copy fields and annotations onto the matching page positions
    const srcPages = pagesOf(tpl.id), dstPages = pagesOf(doc.id);
    const map = new Map(srcPages.map((p, i) => [p.id, dstPages[i]?.id]));
    for (const a of db.prepare('SELECT * FROM annotations WHERE document_id=?').all(tpl.id)) {
      if (!map.get(a.page_id)) continue;
      db.prepare(`INSERT INTO annotations (id,document_id,page_id,author_id,type,x,y,w,h,rotation,z,data,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), doc.id, map.get(a.page_id), u.id, a.type, a.x, a.y, a.w, a.h, a.rotation, a.z, a.data, now(), now());
    }
    for (const f of db.prepare('SELECT * FROM formfields WHERE document_id=?').all(tpl.id)) {
      if (!map.get(f.page_id)) continue;
      db.prepare(`INSERT INTO formfields (id,document_id,page_id,signer_role,type,name,placeholder,required,readonly,
                  validation,validation_pattern,options,value,smart_field,x,y,w,h,font_size,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'',?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), doc.id, map.get(f.page_id), f.signer_role, f.type, f.name, f.placeholder,
             f.required, f.readonly, f.validation, f.validation_pattern, f.options, f.smart_field,
             f.x, f.y, f.w, f.h, f.font_size, now(), now());
    }
    return { document: serializeDoc(doc) };
  });

  r.post('/api/v1/documents/:id/save-as-template', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'templates');
    const doc = docFor(ctx, ctx.params.id);
    requireCountUnder(u, 'templates',
      Number(db.prepare('SELECT COUNT(*) n FROM documents WHERE owner_id=? AND is_template=1').get(u.id).n));
    db.prepare('UPDATE documents SET is_template=1, updated_at=? WHERE id=?').run(now(), doc.id);
    return { document: serializeDoc(db.prepare('SELECT * FROM documents WHERE id=?').get(doc.id)) };
  });

  // --- listing / dashboard ------------------------------------------------
  r.get('/api/v1/documents', async (ctx) => {
    const u = ctx.requireUser();
    const { scope = 'documents', folder_id, q, label_id, limit = '100', offset = '0' } = ctx.query;
    const args = [u.id, u.id, u.email];
    let where = '(d.owner_id=? OR dr.user_id=? OR dr.email=?)';
    if (scope === 'templates') where += ' AND d.is_template=1';
    else if (scope === 'inbox') where += " AND d.state<>'trashed' AND dr.id IS NOT NULL";
    else if (scope === 'sent') where += " AND EXISTS (SELECT 1 FROM sign_requests sr WHERE sr.document_id=d.id AND sr.sender_id=d.owner_id)";
    else if (scope === 'trash') where += " AND d.state='trashed'";
    else where += " AND d.is_template=0 AND d.state<>'trashed'";
    if (folder_id) { where += ' AND d.folder_id=?'; args.push(folder_id); }
    if (q) { where += ' AND d.title LIKE ?'; args.push(`%${q}%`); }
    if (label_id) {
      where += ' AND EXISTS (SELECT 1 FROM document_doc_labels m WHERE m.document_id=d.id AND m.doc_label_id=?)';
      args.push(label_id);
    }
    const rows = db.prepare(`SELECT DISTINCT d.* FROM documents d
      LEFT JOIN document_roles dr ON dr.document_id=d.id
      WHERE ${where} ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(500, Number(limit)), Number(offset));
    return { documents: rows.map(serializeDoc) };
  });

  r.get('/api/v1/entities/dashboard-stats', async (ctx) => {
    const u = ctx.requireUser();
    const n = (sql, ...a) => Number(db.prepare(sql).get(...a)?.n || 0);
    return {
      stats: {
        documents: n("SELECT COUNT(*) n FROM documents WHERE owner_id=? AND is_template=0 AND state<>'trashed'", u.id),
        templates: n('SELECT COUNT(*) n FROM documents WHERE owner_id=? AND is_template=1', u.id),
        completed: n("SELECT COUNT(*) n FROM documents WHERE owner_id=? AND state='completed'", u.id),
        awaiting_signature: n("SELECT COUNT(*) n FROM signers s JOIN sign_requests sr ON sr.id=s.sign_request_id WHERE sr.sender_id=? AND s.state IN ('pending','viewed')", u.id),
        shared_with_me: n('SELECT COUNT(*) n FROM document_roles WHERE user_id=? OR email=?', u.id, u.email),
        folders: n('SELECT COUNT(*) n FROM folders WHERE owner_id=?', u.id),
      },
    };
  });

  r.get('/api/v1/documents/:id', async (ctx) => {
    const doc = docFor(ctx, ctx.params.id);
    if (doc.password_hash && !ctx.unlocked?.has(doc.id) && doc.owner_id !== ctx.user?.id) {
      throw new HttpError(423, 'This document is password protected', { password_required: true });
    }
    db.prepare('INSERT INTO usage_events (id,user_id,metric,amount,period,created_at) SELECT ?,?,?,1,?,? WHERE 1=0')
      .run(randomUUID(), doc.owner_id, 'views', '', now());
    return {
      document: serializeDoc(doc),
      annotations: db.prepare('SELECT * FROM annotations WHERE document_id=? ORDER BY z').all(doc.id),
      formfields: db.prepare('SELECT * FROM formfields WHERE document_id=?').all(doc.id),
      activities: db.prepare('SELECT * FROM document_activities WHERE document_id=? ORDER BY created_at DESC LIMIT 200').all(doc.id),
      comments: db.prepare('SELECT * FROM comments WHERE document_id=? ORDER BY created_at').all(doc.id),
      sign_requests: db.prepare('SELECT * FROM sign_requests WHERE document_id=?').all(doc.id).map((sr) => ({
        ...sr,
        signers: db.prepare('SELECT id,email,name,role_name,position,state,verification,viewed_at,signed_at FROM signers WHERE sign_request_id=?').all(sr.id),
      })),
    };
  });

  r.patch('/api/v1/documents/:id', async (ctx) => {
    const u = ctx.requireUser();
    const doc = docFor(ctx, ctx.params.id, { write: true });
    const { title, folder_id, state } = ctx.body;
    db.prepare('UPDATE documents SET title=COALESCE(?,title), folder_id=COALESCE(?,folder_id), state=COALESCE(?,state), updated_at=? WHERE id=?')
      .run(title ?? null, folder_id ?? null, state ?? null, now(), doc.id);
    publish('document.updated', { id: doc.id }, { documentId: doc.id });
    return { document: serializeDoc(db.prepare('SELECT * FROM documents WHERE id=?').get(doc.id)) };
  });

  /** Complete & save -- the metered action the Free plan caps at 3/month. */
  r.post('/api/v1/documents/:id/complete', async (ctx) => {
    const u = ctx.requireUser();
    const doc = docFor(ctx, ctx.params.id, { write: true });
    if (doc.state === 'completed') return { document: serializeDoc(doc), already_completed: true };
    const missing = db.prepare('SELECT name FROM formfields WHERE document_id=? AND required=1 AND value=\'\'').all(doc.id);
    if (missing.length) throw badRequest(`Required fields are empty: ${missing.map((m) => m.name).join(', ')}`);
    requireQuota(u, 'documents_completed');
    db.prepare("UPDATE documents SET state='completed', completed_at=?, updated_at=? WHERE id=?").run(now(), now(), doc.id);
    meter(u.id, 'documents_completed');
    logActivity(doc.id, { actorId: u.id, actorEmail: u.email, action: 'document.completed' });
    return { document: serializeDoc(db.prepare('SELECT * FROM documents WHERE id=?').get(doc.id)) };
  });

  r.post('/api/v1/documents/batch-delete', async (ctx) => {
    const u = ctx.requireUser();
    const ids = ctx.body.ids || [];
    const stmt = db.prepare("UPDATE documents SET state='trashed', updated_at=? WHERE id=? AND owner_id=?");
    for (const id of ids) stmt.run(now(), id, u.id);
    return { trashed: ids.length };
  });

  r.delete('/api/v1/documents/:id', async (ctx) => {
    const u = ctx.requireUser();
    const doc = db.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(ctx.params.id, u.id);
    if (!doc) throw notFound('Document not found');
    db.prepare('DELETE FROM documents WHERE id=?').run(doc.id);
    return { deleted: true };
  });

  r.post('/api/v1/documents/privatize', async (ctx) => {
    const u = ctx.requireUser();
    for (const id of ctx.body.ids || []) {
      db.prepare('UPDATE documents SET is_private=1 WHERE id=? AND owner_id=?').run(id, u.id);
    }
    return { privatized: true };
  });

  r.post('/api/v1/documents/:id/password', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'document_password');
    const doc = db.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(ctx.params.id, u.id);
    if (!doc) throw notFound('Document not found');
    if (!ctx.body.password) {
      db.prepare('UPDATE documents SET password_hash=NULL WHERE id=?').run(doc.id);
      return { password_protected: false };
    }
    const { salt, hash } = hashPassword(String(ctx.body.password));
    db.prepare('UPDATE documents SET password_hash=? WHERE id=?').run(`${salt}:${hash}`, doc.id);
    logActivity(doc.id, { actorId: u.id, actorEmail: u.email, action: 'document.password_set' });
    return { password_protected: true };
  });

  r.post('/api/v1/documents/:id/unlock', async (ctx) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(ctx.params.id);
    if (!doc?.password_hash) throw badRequest('Document is not password protected');
    const [salt, hash] = doc.password_hash.split(':');
    if (!verifyPassword(String(ctx.body.password || ''), hash, salt)) throw forbidden('Incorrect password');
    ctx.unlock(doc.id);
    return { unlocked: true };
  });

  /** Certification: content hash over pages, fields and annotations. */
  r.post('/api/v1/compiled-pdfs/verify', async (ctx) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(ctx.body.document_id);
    if (!doc) throw notFound('Document not found');
    return {
      document_id: doc.id, certified: !!doc.certified_at,
      certified_at: doc.certified_at, certificate_hash: doc.certificate_hash,
      matches: ctx.body.hash ? ctx.body.hash === doc.certificate_hash : null,
    };
  });

  r.post('/api/v1/documents/:id/certify', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'certification');
    const doc = docFor(ctx, ctx.params.id, { write: true });
    const payload = JSON.stringify({
      pages: pagesOf(doc.id),
      fields: db.prepare('SELECT type,name,value,x,y FROM formfields WHERE document_id=? ORDER BY id').all(doc.id),
      annotations: db.prepare('SELECT type,data,x,y FROM annotations WHERE document_id=? ORDER BY id').all(doc.id),
    });
    const hash = createHash('sha256').update(payload).digest('hex');
    db.prepare('UPDATE documents SET certified_at=?, certificate_hash=? WHERE id=?').run(now(), hash, doc.id);
    logActivity(doc.id, { actorId: u.id, actorEmail: u.email, action: 'document.certified', detail: { hash } });
    return { certified_at: now(), certificate_hash: hash };
  });

  r.get('/api/v1/documents/:id/audit', async (ctx) => {
    const doc = docFor(ctx, ctx.params.id);
    return {
      document: { id: doc.id, title: doc.title, state: doc.state, certificate_hash: doc.certificate_hash },
      activities: db.prepare('SELECT * FROM document_activities WHERE document_id=? ORDER BY created_at').all(doc.id),
      signers: db.prepare(`SELECT s.* FROM signers s JOIN sign_requests sr ON sr.id=s.sign_request_id
                           WHERE sr.document_id=?`).all(doc.id)
        .map((s) => ({ ...s, access_token: undefined })),
    };
  });

  // --- pages --------------------------------------------------------------
  r.post('/api/v1/pages/update-many', async (ctx) => {
    const u = ctx.requireUser();
    const updates = ctx.body.pages || [];
    const stmt = db.prepare('UPDATE pages SET position=COALESCE(?,position), rotation=COALESCE(?,rotation), deleted=COALESCE(?,deleted) WHERE id=?');
    for (const p of updates) {
      const row = db.prepare('SELECT document_id FROM pages WHERE id=?').get(p.id);
      if (!row) continue;
      docFor(ctx, row.document_id, { write: true });
      stmt.run(p.position ?? null, p.rotation ?? null, p.deleted === undefined ? null : (p.deleted ? 1 : 0), p.id);
    }
    const docId = ctx.body.document_id;
    if (docId) {
      db.prepare('UPDATE documents SET page_count=(SELECT COUNT(*) FROM pages WHERE document_id=? AND deleted=0), updated_at=? WHERE id=?')
        .run(docId, now(), docId);
      publish('pages.updated', { document_id: docId }, { documentId: docId });
      logActivity(docId, { actorId: u.id, actorEmail: u.email, action: 'pages.updated', detail: { count: updates.length } });
    }
    return { updated: updates.length, pages: docId ? pagesOf(docId) : [] };
  });

  r.post('/api/v1/pages/duplicate', async (ctx) => {
    const u = ctx.requireUser();
    const src = db.prepare('SELECT * FROM pages WHERE id=?').get(ctx.body.page_id);
    if (!src) throw notFound('Page not found');
    docFor(ctx, src.document_id, { write: true });
    db.prepare('UPDATE pages SET position=position+1 WHERE document_id=? AND position>?').run(src.document_id, src.position);
    const id = randomUUID();
    db.prepare(`INSERT INTO pages (id,document_id,position,source_page_index,rotation,width,height,blank)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, src.document_id, src.position + 1, src.source_page_index, src.rotation, src.width, src.height, src.blank);
    db.prepare('UPDATE documents SET page_count=page_count+1, updated_at=? WHERE id=?').run(now(), src.document_id);
    logActivity(src.document_id, { actorId: u.id, actorEmail: u.email, action: 'page.duplicated' });
    return { page: db.prepare('SELECT * FROM pages WHERE id=?').get(id), pages: pagesOf(src.document_id) };
  });

  r.post('/api/v1/pages/insert-blank', async (ctx) => {
    const u = ctx.requireUser();
    const doc = docFor(ctx, ctx.body.document_id, { write: true });
    const at = Number(ctx.body.position ?? pagesOf(doc.id).length);
    db.prepare('UPDATE pages SET position=position+1 WHERE document_id=? AND position>=?').run(doc.id, at);
    const id = randomUUID();
    db.prepare('INSERT INTO pages (id,document_id,position,width,height,blank) VALUES (?,?,?,?,?,1)')
      .run(id, doc.id, at, Number(ctx.body.width) || 612, Number(ctx.body.height) || 792);
    db.prepare('UPDATE documents SET page_count=page_count+1, updated_at=? WHERE id=?').run(now(), doc.id);
    return { page: db.prepare('SELECT * FROM pages WHERE id=?').get(id), pages: pagesOf(doc.id) };
  });

  r.post('/api/v1/page-labels/parse', async (ctx) => {
    const doc = docFor(ctx, ctx.body.document_id);
    const labels = String(ctx.body.labels || '').split(',').map((s) => s.trim()).filter(Boolean);
    const pages = pagesOf(doc.id);
    db.prepare('DELETE FROM page_labels WHERE page_id IN (SELECT id FROM pages WHERE document_id=?)').run(doc.id);
    const ins = db.prepare('INSERT INTO page_labels (id,page_id,label) VALUES (?,?,?)');
    labels.forEach((l, i) => { if (pages[i]) ins.run(randomUUID(), pages[i].id, l); });
    return { labels };
  });

  // --- annotations (markup) ----------------------------------------------
  r.post('/api/v1/annotations/update-many', async (ctx) => {
    const u = ctx.requireUser();
    const { document_id, created = [], updated = [], deleted = [] } = ctx.body;
    const doc = docFor(ctx, document_id, { write: true });
    const ent = entitlements(u);

    for (const a of created) {
      if (MARKUP_ADVANCED.has(a.type) && !ent.features.pdf_markup_advanced) requireFeature(u, 'pdf_markup_advanced');
      if (a.type === 'stamp') requireFeature(u, 'stamps');
      db.prepare(`INSERT INTO annotations (id,document_id,page_id,author_id,type,x,y,w,h,rotation,z,data,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(a.id || randomUUID(), doc.id, a.page_id, u.id, a.type,
             a.x || 0, a.y || 0, a.w || 0, a.h || 0, a.rotation || 0, a.z || 0,
             JSON.stringify(a.data || {}), now(), now());
    }
    for (const a of updated) {
      db.prepare(`UPDATE annotations SET x=COALESCE(?,x), y=COALESCE(?,y), w=COALESCE(?,w), h=COALESCE(?,h),
                  rotation=COALESCE(?,rotation), z=COALESCE(?,z), data=COALESCE(?,data), updated_at=?
                  WHERE id=? AND document_id=?`)
        .run(a.x ?? null, a.y ?? null, a.w ?? null, a.h ?? null, a.rotation ?? null, a.z ?? null,
             a.data ? JSON.stringify(a.data) : null, now(), a.id, doc.id);
    }
    if (deleted.length) {
      const stmt = db.prepare('DELETE FROM annotations WHERE id=? AND document_id=?');
      for (const id of deleted) stmt.run(id, doc.id);
    }
    db.prepare('UPDATE documents SET updated_at=? WHERE id=?').run(now(), doc.id);
    publish('annotations.changed', { document_id: doc.id, by: u.id }, { documentId: doc.id });
    return { annotations: db.prepare('SELECT * FROM annotations WHERE document_id=? ORDER BY z').all(doc.id) };
  });

  // --- form fields --------------------------------------------------------
  const VALIDATIONS = ['none', 'email', 'number', 'phone', 'zip', 'date', 'ssn', 'regex'];

  r.post('/api/v1/formfields/create-many', async (ctx) => {
    const u = ctx.requireUser();
    const doc = docFor(ctx, ctx.body.document_id, { write: true });
    const ent = entitlements(u);
    const out = [];
    for (const f of ctx.body.formfields || []) {
      if (f.type === 'attachment') requireFeature(u, 'attachment_fields');
      if (f.validation && f.validation !== 'none' && !ent.features.advanced_validation) {
        requireFeature(u, 'advanced_validation');
      }
      if (f.validation && !VALIDATIONS.includes(f.validation)) throw badRequest(`Unknown validation: ${f.validation}`);
      const id = f.id || randomUUID();
      db.prepare(`INSERT INTO formfields (id,document_id,page_id,group_id,signer_role,type,name,placeholder,required,
                  readonly,validation,validation_pattern,options,value,smart_field,x,y,w,h,font_size,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, doc.id, f.page_id, f.group_id ?? null, f.signer_role ?? null, f.type,
             f.name || `Field ${out.length + 1}`, f.placeholder || '', f.required ? 1 : 0, f.readonly ? 1 : 0,
             f.validation || 'none', f.validation_pattern ?? null, JSON.stringify(f.options || []),
             f.value || '', f.smart_field ?? null, f.x || 0, f.y || 0, f.w || 120, f.h || 24,
             f.font_size || 12, now(), now());
      out.push(id);
    }
    publish('formfields.changed', { document_id: doc.id }, { documentId: doc.id });
    return { formfields: db.prepare('SELECT * FROM formfields WHERE document_id=?').all(doc.id) };
  });

  r.post('/api/v1/formfields/update-many', async (ctx) => {
    const doc = docFor(ctx, ctx.body.document_id, { write: true });
    const actor = ctx.user || { id: null, email: ctx.signer?.email };
    for (const f of ctx.body.formfields || []) {
      const row = db.prepare('SELECT * FROM formfields WHERE id=? AND document_id=?').get(f.id, doc.id);
      if (!row) continue;
      if (row.readonly && f.value !== undefined) continue;
      if (f.value !== undefined) {
        const err = validateValue(row, String(f.value));
        if (err) throw badRequest(`${row.name}: ${err}`);
      }
      db.prepare(`UPDATE formfields SET value=COALESCE(?,value), x=COALESCE(?,x), y=COALESCE(?,y),
                  w=COALESCE(?,w), h=COALESCE(?,h), name=COALESCE(?,name), required=COALESCE(?,required),
                  placeholder=COALESCE(?,placeholder), validation=COALESCE(?,validation),
                  options=COALESCE(?,options), signer_role=COALESCE(?,signer_role), font_size=COALESCE(?,font_size),
                  updated_at=? WHERE id=?`)
        .run(f.value ?? null, f.x ?? null, f.y ?? null, f.w ?? null, f.h ?? null, f.name ?? null,
             f.required === undefined ? null : (f.required ? 1 : 0), f.placeholder ?? null,
             f.validation ?? null, f.options ? JSON.stringify(f.options) : null,
             f.signer_role ?? null, f.font_size ?? null, now(), f.id);
    }
    db.prepare('UPDATE documents SET updated_at=? WHERE id=?').run(now(), doc.id);
    publish('formfields.changed', { document_id: doc.id, by: actor.id || actor.email }, { documentId: doc.id });
    return { formfields: db.prepare('SELECT * FROM formfields WHERE document_id=?').all(doc.id) };
  });

  r.post('/api/v1/formfields/delete-many', async (ctx) => {
    const doc = docFor(ctx, ctx.body.document_id, { write: true });
    const stmt = db.prepare('DELETE FROM formfields WHERE id=? AND document_id=?');
    for (const id of ctx.body.ids || []) stmt.run(id, doc.id);
    return { formfields: db.prepare('SELECT * FROM formfields WHERE document_id=?').all(doc.id) };
  });

  // Smart fields: auto-populated values (service `smart-fields` in the bundle).
  r.get('/api/v1/smart-fields', async (ctx) => {
    const u = ctx.requireUser();
    return { smart_fields: {
      'signer.email': ctx.signer?.email || u.email,
      'signer.name': ctx.signer?.name || u.name,
      'date.today': new Date().toISOString().slice(0, 10),
      'document.title': null,
      'sender.name': u.name,
      'sender.email': u.email,
    } };
  });
}

export function validateValue(field, value) {
  if (field.required && !value) return 'is required';
  if (!value) return null;
  switch (field.validation) {
    case 'email': return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? null : 'must be an email address';
    case 'number': return /^-?\d+(\.\d+)?$/.test(value) ? null : 'must be a number';
    case 'phone': return /^[+\d][\d\s().-]{6,}$/.test(value) ? null : 'must be a phone number';
    case 'zip': return /^\d{5}(-\d{4})?$/.test(value) ? null : 'must be a ZIP code';
    case 'date': return !Number.isNaN(Date.parse(value)) ? null : 'must be a date';
    case 'ssn': return /^\d{3}-?\d{2}-?\d{4}$/.test(value) ? null : 'must be an SSN';
    case 'regex':
      try { return new RegExp(field.validation_pattern || '.*').test(value) ? null : 'does not match the required format'; }
      catch { return null; }
    default: return null;
  }
}
