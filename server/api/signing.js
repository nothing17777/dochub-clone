import { randomUUID, randomBytes } from 'node:crypto';
import { db, now } from '../db.js';
import { badRequest, notFound, forbidden } from '../http.js';
import { requireFeature, requireQuota, requireCountUnder, meter } from '../entitlements.js';
import { logActivity, publish, notify, sendEmail } from '../services.js';
import { docFor, serializeDoc, validateValue } from './documents.js';

const baseUrl = (ctx) => process.env.DOCHUB_BASE_URL || `http://${ctx.req.headers.host || 'localhost:4173'}`;

async function createSignRequest(ctx, user, body, { mode = 'remote', batchId = null } = {}) {
  const doc = docFor(ctx, body.document_id, { write: true });
  const recipients = body.signers || [];
  if (!recipients.length) throw badRequest('At least one signer is required');
  const id = randomUUID();
  const envelope = body.envelope_id || `ENV-${randomBytes(4).toString('hex').toUpperCase()}`;
  db.prepare(`INSERT INTO sign_requests (id,document_id,sender_id,subject,message,mode,ordered,state,envelope_id,
              bulk_batch_id,reminder_days,expires_at,created_at)
              VALUES (?,?,?,?,?,?,?,'sent',?,?,?,?,?)`)
    .run(id, doc.id, user.id, body.subject || `Please sign: ${doc.title}`, body.message || '',
         mode, body.ordered ? 1 : 0, envelope, batchId, body.reminder_days ?? null,
         body.expires_at ?? null, now());

  const ins = db.prepare(`INSERT INTO signers (id,sign_request_id,email,name,role_name,position,access_token,
                          state,verification,verification_value,merge_data) VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`);
  const created = [];
  recipients.forEach((s, i) => {
    const sid = randomUUID();
    const token = randomBytes(24).toString('hex');
    ins.run(sid, id, String(s.email).toLowerCase(), s.name || '', s.role_name || `Signer ${i + 1}`,
            i, token, s.verification || 'none', s.verification_value ?? null,
            JSON.stringify(s.merge_data || {}));
    created.push({ id: sid, email: s.email, token });
  });

  // Ordered envelopes only notify the first signer; parallel notifies everyone.
  const toNotify = body.ordered ? created.slice(0, 1) : created;
  for (const s of toNotify) {
    await sendEmail(user, {
      to: s.email, kind: 'sign_request',
      subject: body.subject || `Please sign: ${doc.title}`,
      body: `${body.message || ''}\n\nOpen: ${baseUrl(ctx)}/sign/${s.token}`,
    });
  }
  logActivity(doc.id, {
    actorId: user.id, actorEmail: user.email, action: 'sign_request.sent',
    detail: { signers: recipients.map((s) => s.email), mode, envelope },
  });
  return { id, envelope, signers: created };
}

export default function mount(r) {
  // --- signature library --------------------------------------------------
  r.get('/api/v1/signatures', async (ctx) => {
    const u = ctx.requireUser();
    return { signatures: db.prepare('SELECT * FROM signatures WHERE user_id=? ORDER BY created_at DESC').all(u.id) };
  });

  r.post('/api/v1/signatures/create-with-svg-data', async (ctx) => {
    const u = ctx.requireUser();
    const { svg_data, png_data, kind = 'signature', method = 'draw', font = null } = ctx.body;
    if (!svg_data && !png_data) throw badRequest('svg_data or png_data is required');
    const id = randomUUID();
    db.prepare(`INSERT INTO signatures (id,user_id,kind,method,svg_data,png_data,font,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, u.id, kind, method, svg_data ?? null, png_data ?? null, font, now());
    if (!u.default_signature_id && kind === 'signature') {
      db.prepare('UPDATE users SET default_signature_id=? WHERE id=?').run(id, u.id);
    }
    return { signature: db.prepare('SELECT * FROM signatures WHERE id=?').get(id) };
  });

  r.delete('/api/v1/signatures/:id', async (ctx) => {
    const u = ctx.requireUser();
    db.prepare('DELETE FROM signatures WHERE id=? AND user_id=?').run(ctx.params.id, u.id);
    return { deleted: true };
  });

  /** Self-signature: the metered action the Free plan caps at 5/month. */
  r.post('/api/v1/documents/:id/self-sign', async (ctx) => {
    const u = ctx.requireUser();
    const doc = docFor(ctx, ctx.params.id, { write: true });
    requireQuota(u, 'self_signatures');
    const { signature_id, page_id, x, y, w = 160, h = 50, field_id = null } = ctx.body;
    const sig = db.prepare('SELECT * FROM signatures WHERE id=? AND user_id=?').get(signature_id, u.id);
    if (!sig) throw notFound('Signature not found');
    const id = randomUUID();
    db.prepare(`INSERT INTO annotations (id,document_id,page_id,author_id,type,x,y,w,h,z,data,created_at,updated_at)
                VALUES (?,?,?,?,'signature',?,?,?,?,100,?,?,?)`)
      .run(id, doc.id, page_id, u.id, x, y, w, h,
           JSON.stringify({ signature_id: sig.id, svg: sig.svg_data, png: sig.png_data, signer: u.email }), now(), now());
    if (field_id) db.prepare('UPDATE formfields SET value=? WHERE id=? AND document_id=?').run(sig.id, field_id, doc.id);
    meter(u.id, 'self_signatures');
    logActivity(doc.id, { actorId: u.id, actorEmail: u.email, action: 'document.self_signed' });
    publish('annotations.changed', { document_id: doc.id }, { documentId: doc.id });
    return { annotation: db.prepare('SELECT * FROM annotations WHERE id=?').get(id) };
  });

  // --- sign requests ------------------------------------------------------
  r.post('/api/v1/sign-requests/create-with-document-roles', async (ctx) => {
    const u = ctx.requireUser();
    requireQuota(u, 'sign_requests');
    const res = await createSignRequest(ctx, u, ctx.body);
    meter(u.id, 'sign_requests');
    return { sign_request_id: res.id, envelope_id: res.envelope,
             signers: res.signers.map((s) => ({ id: s.id, email: s.email })) };
  });

  /** Bulk send / mail merge -- one form to many recipients (Pro). */
  r.post('/api/v1/sign-requests/bulk-send', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'bulk_send');
    const rows = ctx.body.recipients || [];
    if (!rows.length) throw badRequest('recipients is required');
    requireQuota(u, 'sign_requests', rows.length);
    const batchId = `BULK-${randomBytes(4).toString('hex').toUpperCase()}`;
    const out = [];
    for (const row of rows) {
      const res = await createSignRequest(ctx, u, {
        document_id: ctx.body.document_id,
        subject: ctx.body.subject, message: ctx.body.message,
        signers: [{ email: row.email, name: row.name, merge_data: row }],
      }, { mode: 'bulk', batchId });
      out.push({ email: row.email, sign_request_id: res.id });
    }
    meter(u.id, 'sign_requests', rows.length);
    return { batch_id: batchId, sent: out.length, requests: out };
  });

  /** In-person signing: hands back a local signing URL for the same device. */
  r.post('/api/v1/sign-requests/in-person', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'in_person_signing');
    const res = await createSignRequest(ctx, u, ctx.body, { mode: 'in_person' });
    return { sign_request_id: res.id,
             signing_urls: res.signers.map((s) => ({ email: s.email, url: `/sign/${s.token}` })) };
  });

  r.post('/api/v1/sign-requests/resend-email', async (ctx) => {
    const u = ctx.requireUser();
    const sr = db.prepare('SELECT * FROM sign_requests WHERE id=? AND sender_id=?').get(ctx.body.sign_request_id, u.id);
    if (!sr) throw notFound('Sign request not found');
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(sr.document_id);
    let n = 0;
    for (const s of db.prepare("SELECT * FROM signers WHERE sign_request_id=? AND state IN ('pending','viewed')").all(sr.id)) {
      await sendEmail(u, { to: s.email, kind: 'sign_reminder', subject: `Reminder: ${sr.subject}`,
                     body: `Open: ${baseUrl(ctx)}/sign/${s.access_token}` });
      n++;
    }
    logActivity(doc.id, { actorId: u.id, actorEmail: u.email, action: 'sign_request.resent', detail: { count: n } });
    return { resent: n };
  });

  r.post('/api/v1/sign-requests/:id/void', async (ctx) => {
    const u = ctx.requireUser();
    const sr = db.prepare('SELECT * FROM sign_requests WHERE id=? AND sender_id=?').get(ctx.params.id, u.id);
    if (!sr) throw notFound('Sign request not found');
    db.prepare("UPDATE sign_requests SET state='voided' WHERE id=?").run(sr.id);
    logActivity(sr.document_id, { actorId: u.id, actorEmail: u.email, action: 'sign_request.voided' });
    return { state: 'voided' };
  });

  r.post('/api/v1/document-reminders', async (ctx) => {
    const u = ctx.requireUser();
    const sr = db.prepare('SELECT * FROM sign_requests WHERE id=? AND sender_id=?').get(ctx.body.sign_request_id, u.id);
    if (!sr) throw notFound('Sign request not found');
    const id = randomUUID();
    db.prepare('INSERT INTO document_reminders (id,sign_request_id,every_days,created_at) VALUES (?,?,?,?)')
      .run(id, sr.id, Number(ctx.body.every_days) || 3, now());
    return { reminder: db.prepare('SELECT * FROM document_reminders WHERE id=?').get(id) };
  });

  // --- signer-facing (token auth, no account needed) ----------------------
  r.get('/api/v1/sign/:token', async (ctx) => {
    const s = db.prepare('SELECT * FROM signers WHERE access_token=?').get(ctx.params.token);
    if (!s) throw notFound('This signing link is not valid');
    const sr = db.prepare('SELECT * FROM sign_requests WHERE id=?').get(s.sign_request_id);
    if (sr.state === 'voided') throw forbidden('This request was voided by the sender');
    if (sr.expires_at && sr.expires_at < now()) throw forbidden('This signing link has expired');
    if (sr.ordered) {
      const ahead = db.prepare("SELECT COUNT(*) n FROM signers WHERE sign_request_id=? AND position<? AND state<>'signed'")
        .get(sr.id, s.position).n;
      if (Number(ahead) > 0) throw forbidden('Waiting on an earlier signer in this envelope');
    }
    if (s.verification !== 'none' && !s.verified) {
      return { verification_required: s.verification, signer: { email: s.email, name: s.name } };
    }
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(sr.document_id);
    if (s.state === 'pending') {
      db.prepare("UPDATE signers SET state='viewed', viewed_at=?, ip=?, user_agent=? WHERE id=?")
        .run(now(), s.id ? (ctx.req.socket.remoteAddress || '') : '', ctx.req.headers['user-agent'] || '', s.id);
      logActivity(doc.id, { actorEmail: s.email, action: 'signer.viewed' });
      notify(sr.sender_id, 'signer_viewed', `${s.email} opened ${doc.title}`, doc.id);
    }
    const merge = JSON.parse(s.merge_data || '{}');
    return {
      signer: { id: s.id, email: s.email, name: s.name, role_name: s.role_name, state: s.state },
      sign_request: { id: sr.id, subject: sr.subject, message: sr.message, mode: sr.mode, envelope_id: sr.envelope_id },
      document: serializeDoc(doc),
      annotations: db.prepare('SELECT * FROM annotations WHERE document_id=? ORDER BY z').all(doc.id),
      formfields: db.prepare('SELECT * FROM formfields WHERE document_id=?').all(doc.id)
        .map((f) => ({ ...f, value: f.value || (f.smart_field ? merge[f.smart_field] || '' : '') })),
      merge_data: merge,
    };
  });

  r.post('/api/v1/sign/:token/verify', async (ctx) => {
    const s = db.prepare('SELECT * FROM signers WHERE access_token=?').get(ctx.params.token);
    if (!s) throw notFound('This signing link is not valid');
    if (s.verification === 'access_code') {
      if (String(ctx.body.value || '') !== String(s.verification_value)) throw forbidden('Incorrect access code');
    } else if (s.verification === 'sms') {
      // No SMS carrier is configured in this build; the recorded value is used.
      if (String(ctx.body.value || '') !== String(s.verification_value)) throw forbidden('Incorrect code');
    }
    db.prepare('UPDATE signers SET verified=1 WHERE id=?').run(s.id);
    return { verified: true };
  });

  r.post('/api/v1/sign/:token/fields', async (ctx) => {
    const s = db.prepare('SELECT * FROM signers WHERE access_token=?').get(ctx.params.token);
    if (!s) throw notFound('This signing link is not valid');
    if (s.state === 'signed') throw forbidden('You have already signed this document');
    const sr = db.prepare('SELECT * FROM sign_requests WHERE id=?').get(s.sign_request_id);
    for (const f of ctx.body.formfields || []) {
      const row = db.prepare('SELECT * FROM formfields WHERE id=? AND document_id=?').get(f.id, sr.document_id);
      if (!row || row.readonly) continue;
      if (row.signer_role && row.signer_role !== s.role_name) continue;
      const err = validateValue(row, String(f.value ?? ''));
      if (err) throw badRequest(`${row.name}: ${err}`);
      db.prepare('UPDATE formfields SET value=?, updated_at=? WHERE id=?').run(String(f.value ?? ''), now(), f.id);
    }
    publish('formfields.changed', { document_id: sr.document_id, by: s.email }, { documentId: sr.document_id });
    return { saved: true };
  });

  r.post('/api/v1/sign/:token/complete', async (ctx) => {
    const s = db.prepare('SELECT * FROM signers WHERE access_token=?').get(ctx.params.token);
    if (!s) throw notFound('This signing link is not valid');
    if (s.state === 'signed') return { already_signed: true };
    const sr = db.prepare('SELECT * FROM sign_requests WHERE id=?').get(s.sign_request_id);
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(sr.document_id);

    const mine = db.prepare('SELECT * FROM formfields WHERE document_id=? AND required=1 AND (signer_role IS NULL OR signer_role=?)')
      .all(doc.id, s.role_name).filter((f) => !f.value);
    if (mine.length) throw badRequest(`Required fields are empty: ${mine.map((f) => f.name).join(', ')}`);

    if (ctx.body.signature_svg || ctx.body.signature_png) {
      db.prepare(`INSERT INTO annotations (id,document_id,page_id,type,x,y,w,h,z,data,created_at,updated_at)
                  VALUES (?,?,?,'signature',?,?,?,?,100,?,?,?)`)
        .run(randomUUID(), doc.id, ctx.body.page_id,
             ctx.body.x ?? 72, ctx.body.y ?? 640, ctx.body.w ?? 160, ctx.body.h ?? 50,
             JSON.stringify({ svg: ctx.body.signature_svg, png: ctx.body.signature_png, signer: s.email }),
             now(), now());
    }
    db.prepare("UPDATE signers SET state='signed', signed_at=?, ip=?, user_agent=? WHERE id=?")
      .run(now(), ctx.req.socket.remoteAddress || '', ctx.req.headers['user-agent'] || '', s.id);
    logActivity(doc.id, { actorEmail: s.email, action: 'signer.signed',
                          detail: { role: s.role_name, envelope: sr.envelope_id },
                          ip: ctx.req.socket.remoteAddress || '', ua: ctx.req.headers['user-agent'] || '' });
    notify(sr.sender_id, 'signer_signed', `${s.email} signed ${doc.title}`, doc.id);

    const pending = db.prepare("SELECT * FROM signers WHERE sign_request_id=? AND state<>'signed' ORDER BY position").all(sr.id);
    if (!pending.length) {
      db.prepare("UPDATE sign_requests SET state='completed', completed_at=? WHERE id=?").run(now(), sr.id);
      db.prepare("UPDATE documents SET state='completed', completed_at=? WHERE id=?").run(now(), doc.id);
      logActivity(doc.id, { action: 'sign_request.completed' });
      const sender = db.prepare('SELECT * FROM users WHERE id=?').get(sr.sender_id);
      await sendEmail(sender, { to: sender.email, kind: 'completed',
                          subject: `Completed: ${doc.title}`, body: 'All signers have signed.' });
    } else if (sr.ordered) {
      const next = pending[0];
      const sender = db.prepare('SELECT * FROM users WHERE id=?').get(sr.sender_id);
      await sendEmail(sender, { to: next.email, kind: 'sign_request', subject: sr.subject,
                          body: `Open: ${baseUrl(ctx)}/sign/${next.access_token}` });
    }
    publish('signer.signed', { document_id: doc.id, email: s.email }, { documentId: doc.id });
    return { signed: true, envelope_complete: !pending.length };
  });

  r.post('/api/v1/sign/:token/decline', async (ctx) => {
    const s = db.prepare('SELECT * FROM signers WHERE access_token=?').get(ctx.params.token);
    if (!s) throw notFound('This signing link is not valid');
    const sr = db.prepare('SELECT * FROM sign_requests WHERE id=?').get(s.sign_request_id);
    db.prepare("UPDATE signers SET state='declined', declined_reason=? WHERE id=?")
      .run(String(ctx.body.reason || ''), s.id);
    db.prepare("UPDATE sign_requests SET state='declined' WHERE id=?").run(sr.id);
    logActivity(sr.document_id, { actorEmail: s.email, action: 'signer.declined', detail: { reason: ctx.body.reason } });
    notify(sr.sender_id, 'signer_declined', `${s.email} declined to sign`, sr.document_id);
    return { declined: true };
  });

  // --- collaborators, folders, labels, comments --------------------------
  r.post('/api/v1/document-roles/create-with-emails', async (ctx) => {
    const u = ctx.requireUser();
    const doc = docFor(ctx, ctx.body.document_id, { write: true });
    const emails = (ctx.body.emails || []).map((e) => String(e).toLowerCase());
    const current = Number(db.prepare('SELECT COUNT(*) n FROM document_roles WHERE document_id=?').get(doc.id).n);
    requireCountUnder(u, 'collaborators', current + emails.length - 1);
    const ins = db.prepare(`INSERT INTO document_roles (id,document_id,user_id,email,role,state,created_at)
                            VALUES (?,?,?,?,?,'invited',?)`);
    for (const email of emails) {
      const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
      ins.run(randomUUID(), doc.id, existing?.id ?? null, email, ctx.body.role || 'collaborator', now());
      await sendEmail(u, { to: email, kind: 'share', subject: `${u.name} shared "${doc.title}" with you`,
                     body: `Open: ${baseUrl(ctx)}/d/${doc.id}` });
      if (existing) notify(existing.id, 'shared', `${u.name} shared ${doc.title}`, doc.id);
    }
    logActivity(doc.id, { actorId: u.id, actorEmail: u.email, action: 'document.shared', detail: { emails } });
    return { roles: db.prepare('SELECT id,email,role,state FROM document_roles WHERE document_id=?').all(doc.id) };
  });

  r.delete('/api/v1/document-roles/:id', async (ctx) => {
    const u = ctx.requireUser();
    const role = db.prepare('SELECT * FROM document_roles WHERE id=?').get(ctx.params.id);
    if (!role) throw notFound();
    docFor(ctx, role.document_id, { write: true });
    db.prepare('DELETE FROM document_roles WHERE id=?').run(role.id);
    return { removed: true };
  });

  r.get('/api/v1/folders', async (ctx) => {
    const u = ctx.requireUser();
    return { folders: db.prepare('SELECT * FROM folders WHERE owner_id=? ORDER BY name').all(u.id) };
  });

  r.post('/api/v1/folders', async (ctx) => {
    const u = ctx.requireUser();
    requireCountUnder(u, 'folders', Number(db.prepare('SELECT COUNT(*) n FROM folders WHERE owner_id=?').get(u.id).n));
    const id = randomUUID();
    db.prepare('INSERT INTO folders (id,owner_id,parent_id,name,color,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, u.id, ctx.body.parent_id ?? null, ctx.body.name || 'New folder', ctx.body.color || '#8a94a6', now());
    return { folder: db.prepare('SELECT * FROM folders WHERE id=?').get(id) };
  });

  r.delete('/api/v1/folders/:id', async (ctx) => {
    const u = ctx.requireUser();
    db.prepare('DELETE FROM folders WHERE id=? AND owner_id=?').run(ctx.params.id, u.id);
    return { deleted: true };
  });

  r.post('/api/v1/documents/remove-folders', async (ctx) => {
    const u = ctx.requireUser();
    for (const id of ctx.body.ids || []) {
      db.prepare('UPDATE documents SET folder_id=NULL WHERE id=? AND owner_id=?').run(id, u.id);
    }
    return { updated: true };
  });

  r.post('/api/v1/folder-permissions/create-many', async (ctx) => {
    const u = ctx.requireUser();
    const folder = db.prepare('SELECT * FROM folders WHERE id=? AND owner_id=?').get(ctx.body.folder_id, u.id);
    if (!folder) throw notFound('Folder not found');
    const ins = db.prepare('INSERT INTO folder_permissions (id,folder_id,user_id,email,level,created_at) VALUES (?,?,?,?,?,?)');
    for (const email of ctx.body.emails || []) {
      const existing = db.prepare('SELECT id FROM users WHERE email=?').get(String(email).toLowerCase());
      ins.run(randomUUID(), folder.id, existing?.id ?? null, String(email).toLowerCase(), ctx.body.level || 'view', now());
    }
    return { permissions: db.prepare('SELECT * FROM folder_permissions WHERE folder_id=?').all(folder.id) };
  });

  r.get('/api/v1/doc-labels', async (ctx) => {
    const u = ctx.requireUser();
    return { doc_labels: db.prepare('SELECT * FROM doc_labels WHERE owner_id=?').all(u.id) };
  });

  r.post('/api/v1/doc-labels', async (ctx) => {
    const u = ctx.requireUser();
    const id = randomUUID();
    db.prepare('INSERT INTO doc_labels (id,owner_id,name,color) VALUES (?,?,?,?)')
      .run(id, u.id, ctx.body.name || 'Label', ctx.body.color || '#2d7ff9');
    return { doc_label: db.prepare('SELECT * FROM doc_labels WHERE id=?').get(id) };
  });

  r.post('/api/v1/documents/assign-many-doc-labels', async (ctx) => {
    const u = ctx.requireUser();
    const ins = db.prepare('INSERT OR IGNORE INTO document_doc_labels (document_id,doc_label_id) VALUES (?,?)');
    for (const docId of ctx.body.document_ids || []) {
      docFor(ctx, docId, { write: true });
      for (const labelId of ctx.body.doc_label_ids || []) ins.run(docId, labelId);
    }
    return { assigned: true };
  });

  r.post('/api/v1/comments', async (ctx) => {
    const u = ctx.requireUser();
    const doc = docFor(ctx, ctx.body.document_id);
    const id = randomUUID();
    db.prepare(`INSERT INTO comments (id,document_id,annotation_id,author_id,body,created_at)
                VALUES (?,?,?,?,?,?)`)
      .run(id, doc.id, ctx.body.annotation_id ?? null, u.id, String(ctx.body.body || ''), now());
    // @mentions
    for (const m of String(ctx.body.body || '').matchAll(/@([\w.+-]+@[\w.-]+)/g)) {
      const email = m[1].toLowerCase();
      const target = db.prepare('SELECT id FROM users WHERE email=?').get(email);
      db.prepare('INSERT INTO mentions (id,comment_id,user_id,email,created_at) VALUES (?,?,?,?,?)')
        .run(randomUUID(), id, target?.id ?? null, email, now());
      if (target) notify(target.id, 'mention', `${u.name} mentioned you on ${doc.title}`, doc.id);
      else await sendEmail(u, { to: email, kind: 'mention', subject: `${u.name} mentioned you`, body: ctx.body.body });
    }
    publish('comment.created', { document_id: doc.id, id }, { documentId: doc.id });
    return { comment: db.prepare('SELECT * FROM comments WHERE id=?').get(id) };
  });

  r.post('/api/v1/comments/:id/resolve', async (ctx) => {
    const u = ctx.requireUser();
    const c = db.prepare('SELECT * FROM comments WHERE id=?').get(ctx.params.id);
    if (!c) throw notFound();
    docFor(ctx, c.document_id);
    db.prepare('UPDATE comments SET resolved=1 WHERE id=?').run(c.id);
    return { resolved: true };
  });

  r.get('/api/v1/mention-suggestions', async (ctx) => {
    const u = ctx.requireUser();
    const q = `%${String(ctx.query.q || '')}%`;
    return { suggestions: db.prepare(`SELECT DISTINCT email FROM document_roles WHERE email LIKE ?
                                      UNION SELECT email FROM users WHERE email LIKE ? LIMIT 10`).all(q, q) };
  });
}
