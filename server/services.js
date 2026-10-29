// Side-effecting integrations. Each one has a real local implementation and a
// clearly flagged provider seam: nothing here silently pretends to have
// reached the outside world.
import { randomUUID } from 'node:crypto';
import { db, now, period } from './db.js';
import { meter, requireQuota } from './entitlements.js';
import { smtpSend, smtpStatus } from './mailer.js';
import { PROVIDERS as OAUTH_PROVIDERS, credentials } from './oauth.js';

export { smtpStatus };

export const DELIVERY_MODE = process.env.DOCHUB_DELIVERY || 'local';
// 'local' -> recorded in the email_records / outbound_faxes tables only
// 'smtp'  -> handed to the SMTP server named by DOCHUB_SMTP_URL; the row's
//            state becomes `sent` or `failed` with the transport's own error.
const subscribers = new Set();

/** Server-sent-events fan-out. Stands in for the ActionCable channel the
 *  production app uses (service `action-cable` in the observed bundle). */
export function subscribe(res, { userId, documentId }) {
  const entry = { res, userId, documentId };
  subscribers.add(entry);
  res.on('close', () => subscribers.delete(entry));
  return entry;
}

export function publish(event, payload, { documentId = null, userId = null } = {}) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const s of subscribers) {
    if (documentId && s.documentId !== documentId) continue;
    if (userId && s.userId !== userId) continue;
    try { s.res.write(frame); } catch { subscribers.delete(s); }
  }
}

export async function sendEmail(user, { to, subject, body, kind = 'generic' }) {
  if (user) requireQuota(user, 'emails_per_day');
  const id = randomUUID();
  const smtp = DELIVERY_MODE === 'smtp';
  db.prepare(`INSERT INTO email_records (id,user_id,to_email,subject,body,kind,state,provider,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, user?.id ?? null, to, subject, body, kind,
         smtp ? 'queued' : 'recorded_locally', smtp ? 'smtp' : 'local', now());
  if (user) meter(user.id, 'emails_per_day');

  let record;
  if (smtp) {
    try {
      const info = await smtpSend({ to, subject, body });
      db.prepare("UPDATE email_records SET state='sent', sent_at=?, message_id=?, error=NULL WHERE id=?")
        .run(now(), info.messageId, id);
    } catch (err) {
      // A delivery failure is recorded as such; it never reads as a send.
      db.prepare("UPDATE email_records SET state='failed', error=? WHERE id=?").run(String(err.message), id);
    }
    record = db.prepare('SELECT * FROM email_records WHERE id=?').get(id);
  } else {
    record = db.prepare('SELECT * FROM email_records WHERE id=?').get(id);
  }
  publish('email.sent', { id, to, subject, kind, state: record.state }, { userId: user?.id });
  return { id, state: record.state, to, subject, error: record.error || null, provider: record.provider };
}

export function notify(userId, kind, body, documentId = null) {
  const id = randomUUID();
  db.prepare('INSERT INTO notifications (id,user_id,kind,body,document_id,read,created_at) VALUES (?,?,?,?,?,0,?)')
    .run(id, userId, kind, body, documentId, now());
  publish('notification', { id, kind, body, document_id: documentId }, { userId });
  return id;
}

export function logActivity(documentId, { actorId = null, actorEmail = null, action, detail = {}, ip = '', ua = '' }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO document_activities (id,document_id,actor_id,actor_email,action,detail,ip,user_agent,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, documentId, actorId, actorEmail, action, JSON.stringify(detail), ip, ua, now());
  publish('activity', { id, document_id: documentId, action, detail }, { documentId });
  return id;
}

/** Fax. The carrier seam is unimplemented, so a send is recorded and marked
 *  `no_carrier_configured` rather than reported as delivered. */
export function sendFax(user, { documentId, toNumber, pages }) {
  requireQuota(user, 'fax_pages', pages);
  const id = randomUUID();
  const configured = !!process.env.DOCHUB_FAX_PROVIDER_URL;
  db.prepare(`INSERT INTO outbound_faxes (id,user_id,document_id,to_number,pages,state,error,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, user.id, documentId, toNumber, pages,
         configured ? 'queued' : 'failed',
         configured ? null : 'no_carrier_configured', now());
  meter(user.id, 'fax_pages', pages);
  return db.prepare('SELECT * FROM outbound_faxes WHERE id=?').get(id);
}

export function provisionFaxNumber(user, areaCode) {
  const number = `+1${areaCode}${String(Math.floor(1000000 + Math.random() * 8999999)).slice(0, 7)}`;
  const id = randomUUID();
  db.prepare('INSERT INTO fax_number_provisions (id,user_id,area_code,fax_number,state,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, user.id, areaCode, number, 'provisioned', now());
  return db.prepare('SELECT * FROM fax_number_provisions WHERE id=?').get(id);
}

export const AREA_CODES = ['212', '305', '312', '415', '512', '617', '702', '737', '802', '917'];

/** Cloud storage / mail integrations. The OAuth authorization-code flow is in
 *  server/oauth.js; a provider is connectable only once both its client id and
 *  secret are present, and the status below says exactly which are missing. */
export const INTEGRATION_PROVIDERS = Object.entries(OAUTH_PROVIDERS)
  .map(([provider, p]) => ({ provider, label: p.label }));

export function integrationStatus(user) {
  const rows = db.prepare('SELECT * FROM integrations WHERE user_id=?').all(user.id);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return INTEGRATION_PROVIDERS.map((p) => {
    const c = credentials(p.provider);
    const row = byProvider.get(p.provider);
    return {
      provider: p.provider,
      label: p.label,
      credentials_configured: c.configured,
      missing_env: c.configured ? [] : [c.id_var, c.secret_var].filter((v) => !process.env[v]),
      scopes: OAUTH_PROVIDERS[p.provider].scopes,
      state: row?.state || 'disconnected',
      account_label: row?.account_label || null,
      connected_at: row?.connected_at || null,
      error: row?.error || null,
    };
  });
}
