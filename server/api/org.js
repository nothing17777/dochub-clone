import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { badRequest, notFound, forbidden } from '../http.js';
import { requireFeature, requireCountUnder, entitlements, MATRIX, PLANS } from '../entitlements.js';
import { sendEmail, notify, provisionFaxNumber, sendFax, AREA_CODES, integrationStatus } from '../services.js';
import { spEntityId, acsUrl, baseUrl } from '../saml.js';

const orgOf = (ctx, { admin = false } = {}) => {
  const u = ctx.requireUser();
  if (!u.organization_id) throw badRequest('You are not in an organization');
  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(u.organization_id);
  if (admin) {
    const role = db.prepare('SELECT * FROM organization_roles WHERE organization_id=? AND user_id=?').get(org.id, u.id);
    if (org.owner_id !== u.id && role?.role !== 'admin') throw forbidden('Organization admins only');
  }
  return org;
};

export default function mount(r) {
  // --- organizations ------------------------------------------------------
  r.post('/api/v1/organizations', async (ctx) => {
    const u = ctx.requireUser();
    const id = randomUUID();
    db.prepare('INSERT INTO organizations (id,name,owner_id,plan,created_at) VALUES (?,?,?,?,?)')
      .run(id, ctx.body.name || `${u.name}'s team`, u.id, u.plan, now());
    db.prepare(`INSERT INTO organization_roles (id,organization_id,user_id,email,role,state,created_at)
                VALUES (?,?,?,?,'owner','active',?)`).run(randomUUID(), id, u.id, u.email, now());
    db.prepare('UPDATE users SET organization_id=? WHERE id=?').run(id, u.id);
    return { organization: db.prepare('SELECT * FROM organizations WHERE id=?').get(id) };
  });

  r.get('/api/v1/organizations/current', async (ctx) => {
    const u = ctx.requireUser();
    if (!u.organization_id) return { organization: null };
    const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(u.organization_id);
    return {
      organization: org,
      members: db.prepare('SELECT * FROM organization_roles WHERE organization_id=? ORDER BY created_at').all(org.id),
      groups: db.prepare('SELECT * FROM user_groups WHERE organization_id=?').all(org.id),
      domains: db.prepare('SELECT * FROM domain_settings WHERE organization_id=?').all(org.id),
      saml: db.prepare('SELECT * FROM saml_settings WHERE organization_id=?').get(org.id) || null,
      sub_organizations: db.prepare('SELECT * FROM organizations WHERE parent_id=?').all(org.id),
      rooms: db.prepare('SELECT * FROM rooms WHERE organization_id=?').all(org.id),
    };
  });

  r.post('/api/v1/organization-roles/create-with-emails', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    const u = ctx.user;
    const emails = (ctx.body.emails || []).map((e) => String(e).toLowerCase());
    const current = Number(db.prepare("SELECT COUNT(*) n FROM organization_roles WHERE organization_id=? AND state<>'removed'")
      .get(org.id).n);
    requireCountUnder(u, 'team_members', current + emails.length - 1);
    const ins = db.prepare(`INSERT INTO organization_roles (id,organization_id,user_id,email,role,state,created_at)
                            VALUES (?,?,?,?,?,'invited',?)`);
    for (const email of emails) {
      const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
      ins.run(randomUUID(), org.id, existing?.id ?? null, email, ctx.body.role || 'member', now());
      await sendEmail(u, { to: email, kind: 'team_invite', subject: `You're invited to ${org.name} on DocHub`,
                     body: 'Sign in to accept the invitation.' });
      if (existing) notify(existing.id, 'team_invite', `${u.name} invited you to ${org.name}`);
    }
    return { members: db.prepare('SELECT * FROM organization_roles WHERE organization_id=?').all(org.id) };
  });

  r.post('/api/v1/organization-roles/:id/accept', async (ctx) => {
    const u = ctx.requireUser();
    const role = db.prepare('SELECT * FROM organization_roles WHERE id=?').get(ctx.params.id);
    if (!role || (role.email !== u.email && role.user_id !== u.id)) throw notFound('Invitation not found');
    db.prepare("UPDATE organization_roles SET state='active', user_id=? WHERE id=?").run(u.id, role.id);
    db.prepare('UPDATE users SET organization_id=? WHERE id=?').run(role.organization_id, u.id);
    return { accepted: true };
  });

  r.patch('/api/v1/organization-roles/:id', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    const role = db.prepare('SELECT * FROM organization_roles WHERE id=? AND organization_id=?').get(ctx.params.id, org.id);
    if (!role) throw notFound();
    if (role.role === 'owner') throw forbidden('The owner role cannot be changed here');
    db.prepare('UPDATE organization_roles SET role=COALESCE(?,role), state=COALESCE(?,state) WHERE id=?')
      .run(ctx.body.role ?? null, ctx.body.state ?? null, role.id);
    if (ctx.body.state === 'removed' && role.user_id) {
      db.prepare('UPDATE users SET organization_id=NULL WHERE id=?').run(role.user_id);
    }
    return { member: db.prepare('SELECT * FROM organization_roles WHERE id=?').get(role.id) };
  });

  r.post('/api/v1/user-groups', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    const id = randomUUID();
    db.prepare('INSERT INTO user_groups (id,organization_id,name,created_at) VALUES (?,?,?,?)')
      .run(id, org.id, ctx.body.name || 'Group', now());
    return { user_group: db.prepare('SELECT * FROM user_groups WHERE id=?').get(id) };
  });

  /** Sub-organizations and digital rooms are Site License features. */
  r.post('/api/v1/organizations/sub', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    requireFeature(ctx.user, 'sub_organizations');
    const id = randomUUID();
    db.prepare('INSERT INTO organizations (id,name,owner_id,plan,parent_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, ctx.body.name || 'Sub-organization', ctx.user.id, org.plan, org.id, now());
    return { organization: db.prepare('SELECT * FROM organizations WHERE id=?').get(id) };
  });

  r.post('/api/v1/rooms', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    requireFeature(ctx.user, 'rooms');
    const id = randomUUID();
    db.prepare('INSERT INTO rooms (id,organization_id,name,created_at) VALUES (?,?,?,?)')
      .run(id, org.id, ctx.body.name || 'Room', now());
    for (const email of ctx.body.emails || []) {
      db.prepare('INSERT INTO room_roles (id,room_id,email,role) VALUES (?,?,?,?)')
        .run(randomUUID(), id, String(email).toLowerCase(), 'member');
    }
    return { room: db.prepare('SELECT * FROM rooms WHERE id=?').get(id) };
  });

  /** HIPAA BAA acceptance -- Site License only. */
  r.post('/api/v1/organizations/hipaa-baa', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    requireFeature(ctx.user, 'hipaa_baa');
    if (!ctx.body.accepted) throw badRequest('accepted must be true');
    db.prepare('UPDATE organizations SET hipaa_baa_accepted=1, hipaa_baa_accepted_at=? WHERE id=?').run(now(), org.id);
    return { hipaa_baa_accepted: true, accepted_at: now(),
             note: 'Recorded in this deployment. A countersigned BAA is a legal agreement, not a toggle.' };
  });

  // --- SSO / SAML ---------------------------------------------------------
  r.post('/api/v1/saml-settings', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    requireFeature(ctx.user, 'sso');
    const existing = db.prepare('SELECT * FROM saml_settings WHERE organization_id=?').get(org.id);
    const id = existing?.id || randomUUID();
    if (existing) {
      db.prepare(`UPDATE saml_settings SET idp_entity_id=?, idp_sso_url=?, idp_certificate=?, enabled=? WHERE id=?`)
        .run(ctx.body.idp_entity_id ?? null, ctx.body.idp_sso_url ?? null,
             ctx.body.idp_certificate ?? null, ctx.body.enabled ? 1 : 0, id);
    } else {
      db.prepare(`INSERT INTO saml_settings (id,organization_id,idp_entity_id,idp_sso_url,idp_certificate,enabled,created_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(id, org.id, ctx.body.idp_entity_id ?? null, ctx.body.idp_sso_url ?? null,
             ctx.body.idp_certificate ?? null, ctx.body.enabled ? 1 : 0, now());
    }
    const configured = !!(ctx.body.idp_sso_url && ctx.body.idp_certificate);
    return {
      saml_setting: db.prepare('SELECT * FROM saml_settings WHERE id=?').get(id),
      sp_metadata: { entity_id: spEntityId(ctx), acs_url: acsUrl(ctx),
                     metadata_url: `${baseUrl(ctx)}/api/v1/saml/metadata` },
      assertion_processing: configured ? 'active' : 'inactive',
      note: configured
        ? 'Assertions posted to the ACS are validated against this certificate '
          + '(RSA-SHA1/SHA256, enveloped signature, exclusive or inclusive c14n). '
          + 'Encrypted assertions are refused rather than skipped.'
        : 'Stored. Sign-in stays off until both an IdP sign-in URL and an IdP certificate are set.',
    };
  });

  r.post('/api/v1/domain-settings', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    requireFeature(ctx.user, 'sso');
    const count = Number(db.prepare('SELECT COUNT(*) n FROM domain_settings WHERE organization_id=?').get(org.id).n);
    const cap = entitlements(ctx.user).limits.sso_domains;
    if (cap !== Infinity && count >= cap) throw badRequest(`Your plan allows ${cap} SSO domains`);
    const id = randomUUID();
    db.prepare('INSERT INTO domain_settings (id,organization_id,domain_name,verified,created_at) VALUES (?,?,?,0,?)')
      .run(id, org.id, String(ctx.body.domain_name || '').toLowerCase(), now());
    return { domain_setting: db.prepare('SELECT * FROM domain_settings WHERE id=?').get(id),
             verification_record: { type: 'TXT', name: '_dochub', value: `dochub-verify=${id.slice(0, 12)}` } };
  });

  r.post('/api/v1/organizations/sso-enforced', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    requireFeature(ctx.user, 'sso');
    db.prepare('UPDATE organizations SET sso_enforced=? WHERE id=?').run(ctx.body.enforced ? 1 : 0, org.id);
    return { sso_enforced: !!ctx.body.enforced };
  });

  // --- admin oversight (Site License) ------------------------------------
  r.get('/api/v1/admin-stats/home-page-stats-v2', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    requireFeature(ctx.user, 'admin_oversight');
    const ids = db.prepare("SELECT user_id FROM organization_roles WHERE organization_id=? AND state='active' AND user_id IS NOT NULL")
      .all(org.id).map((r) => r.user_id);
    const placeholders = ids.map(() => '?').join(',') || "''";
    const n = (sql) => Number(db.prepare(sql).get(...ids)?.n || 0);
    return { stats: {
      members: ids.length,
      documents: n(`SELECT COUNT(*) n FROM documents WHERE owner_id IN (${placeholders})`),
      completed: n(`SELECT COUNT(*) n FROM documents WHERE state='completed' AND owner_id IN (${placeholders})`),
      sign_requests: n(`SELECT COUNT(*) n FROM sign_requests WHERE sender_id IN (${placeholders})`),
      emails: n(`SELECT COUNT(*) n FROM email_records WHERE user_id IN (${placeholders})`),
    } };
  });

  r.get('/api/v1/organizations/login-activity', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    requireFeature(ctx.user, 'admin_oversight');
    return { login_activity: db.prepare(`SELECT la.*, u.email FROM login_activity la JOIN users u ON u.id=la.user_id
      WHERE u.organization_id=? ORDER BY la.created_at DESC LIMIT 200`).all(org.id) };
  });

  r.get('/api/v1/organizations/document-activity', async (ctx) => {
    const org = orgOf(ctx, { admin: true });
    requireFeature(ctx.user, 'admin_oversight');
    return { activities: db.prepare(`SELECT da.* FROM document_activities da JOIN documents d ON d.id=da.document_id
      JOIN users u ON u.id=d.owner_id WHERE u.organization_id=? ORDER BY da.created_at DESC LIMIT 200`).all(org.id) };
  });

  r.post('/api/v2/site_license_requests', async (ctx) => {
    const u = ctx.user;
    await sendEmail(u, { to: 'sales@dochub.local', kind: 'site_license',
                   subject: 'Site License enquiry',
                   body: JSON.stringify({ from: u?.email, ...ctx.body }) });
    return { received: true, note: 'Site License pricing is custom; this records the enquiry.' };
  });

  // --- fax ----------------------------------------------------------------
  r.get('/api/v1/fax-number-provisions/available-fax-area-codes', async () => ({ area_codes: AREA_CODES }));

  r.post('/api/v1/fax-number-provisions', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'fax');
    if (!AREA_CODES.includes(String(ctx.body.area_code))) throw badRequest('Unavailable area code');
    return { fax_number_provision: provisionFaxNumber(u, String(ctx.body.area_code)) };
  });

  r.get('/api/v1/fax-number-provisions', async (ctx) => {
    const u = ctx.requireUser();
    return { fax_number_provisions: db.prepare('SELECT * FROM fax_number_provisions WHERE user_id=?').all(u.id) };
  });

  r.post('/api/v1/outbound-faxes', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'fax');
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(ctx.body.document_id);
    if (!doc) throw notFound('Document not found');
    const fax = sendFax(u, { documentId: doc.id, toNumber: String(ctx.body.to_number || ''),
                             pages: Number(ctx.body.pages) || doc.page_count });
    return { outbound_fax: fax };
  });

  r.get('/api/v1/outbound-faxes', async (ctx) => {
    const u = ctx.requireUser();
    return { outbound_faxes: db.prepare('SELECT * FROM outbound_faxes WHERE user_id=? ORDER BY created_at DESC').all(u.id) };
  });

  r.get('/api/v1/inbound-faxes', async (ctx) => {
    const u = ctx.requireUser();
    return { inbound_faxes: db.prepare('SELECT * FROM inbound_faxes WHERE user_id=? ORDER BY created_at DESC').all(u.id) };
  });

  // --- integrations -------------------------------------------------------
  r.get('/api/v1/integrations', async (ctx) => ({ integrations: integrationStatus(ctx.requireUser()) }));

  /** Import by URL -- the one cloud import path that works without OAuth. */
  r.post('/api/v1/import-source-url-tasks', async (ctx) => {
    const u = ctx.requireUser();
    const url = String(ctx.body.url || '');
    if (!/^https:\/\//.test(url)) throw badRequest('An https URL is required');
    const id = randomUUID();
    db.prepare(`INSERT INTO export_tasks (id,user_id,document_id,kind,state,created_at)
                VALUES (?,?,NULL,'import_url','queued',?)`).run(id, u.id, now());
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      db.prepare("UPDATE export_tasks SET state='succeeded', finished_at=? WHERE id=?").run(now(), id);
      return { task_id: id, state: 'succeeded', byte_size: buf.length,
               data_base64: buf.toString('base64'),
               content_type: res.headers.get('content-type') || 'application/octet-stream' };
    } catch (err) {
      db.prepare("UPDATE export_tasks SET state='failed', error=?, finished_at=? WHERE id=?")
        .run(String(err.message), now(), id);
      throw badRequest(`Import failed: ${err.message}`);
    }
  });
}
