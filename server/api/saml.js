import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { badRequest, notFound, forbidden } from '../http.js';
import { createUser, getUserByEmail, startSession, sessionCookie } from '../auth.js';
import { publicUser } from './auth.js';
import {
  spMetadata, spEntityId, acsUrl, orgForEmail, samlFor,
  authnRequest, validateResponse, SamlError,
} from '../saml.js';

export default function mount(r) {
  r.get('/api/v1/saml/metadata', async (ctx) => {
    ctx.raw(200, 'application/samlmetadata+xml; charset=utf-8', Buffer.from(spMetadata(ctx), 'utf8'));
    return null;
  });

  /** Does this address sign in through an IdP, and if so, where to? */
  r.post('/api/v1/saml/login', async (ctx) => {
    const email = String(ctx.body.email || '').toLowerCase();
    const org = orgForEmail(email);
    if (!org) return { sso: false, reason: 'no verified SSO domain matches that address' };
    const settings = samlFor(org.id);
    if (!settings?.enabled) return { sso: false, reason: 'SSO is not enabled for that organization' };
    if (!settings.idp_sso_url) return { sso: false, reason: 'the organization has no IdP sign-in URL configured' };
    const req = authnRequest(ctx, org, settings, String(ctx.body.relay_state || '/'));
    return { sso: true, organization: { id: org.id, name: org.name },
             sso_enforced: !!org.sso_enforced, request_id: req.id, redirect_url: req.url };
  });

  /** Assertion Consumer Service. An IdP posts the signed response here. */
  r.post('/api/v1/saml/acs', async (ctx) => {
    const raw = ctx.body.SAMLResponse || ctx.body.saml_response;
    if (!raw) throw badRequest('SAMLResponse is required');
    const relay = String(ctx.body.RelayState || ctx.body.relay_state || '/');

    // Work out which organization the response belongs to: either the
    // InResponseTo request we issued, or the asserted email's verified domain.
    let doc = null, org = null;
    try { doc = Buffer.from(String(raw), 'base64').toString('utf8'); } catch { /* reported below */ }
    const inResponseTo = (doc?.match(/InResponseTo="([^"]+)"/) || [])[1];
    if (inResponseTo) {
      const req = db.prepare('SELECT * FROM saml_requests WHERE id=?').get(inResponseTo);
      if (req) org = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.organization_id);
    }
    if (!org) {
      const asserted = (doc?.match(/>([^<>\s]+@[^<>\s]+)</) || [])[1];
      org = asserted ? orgForEmail(asserted) : null;
    }
    if (!org) throw badRequest('Could not match this assertion to an organization with a verified domain');
    const settings = samlFor(org.id);

    let claims;
    try {
      claims = validateResponse(ctx, raw, { settings, org });
    } catch (err) {
      if (settings) db.prepare('UPDATE saml_settings SET last_error=? WHERE id=?').run(String(err.message), settings.id);
      if (err instanceof SamlError) throw forbidden(`SAML sign-in refused: ${err.message}`);
      throw err;
    }

    // Map the asserted identity onto a user, provisioning on first sign-in.
    let user = getUserByEmail(claims.email);
    if (!user) {
      user = createUser({ email: claims.email, name: claims.attributes.displayName?.[0] || '',
                          provider: 'saml', plan: org.plan });
      db.prepare('UPDATE users SET organization_id=? WHERE id=?').run(org.id, user.id);
      db.prepare(`INSERT INTO organization_roles (id,organization_id,user_id,email,role,state,created_at)
                  VALUES (?,?,?,?,'member','active',?)`).run(randomUUID(), org.id, user.id, user.email, now());
    } else if (!user.organization_id) {
      db.prepare('UPDATE users SET organization_id=? WHERE id=?').run(org.id, user.id);
    } else if (user.organization_id !== org.id) {
      throw forbidden('SAML sign-in refused: that account belongs to a different organization');
    }
    db.prepare('UPDATE users SET saml_name_id=?, provider=? WHERE id=?').run(claims.nameId, 'saml', user.id);
    db.prepare('UPDATE saml_settings SET last_login_at=?, last_error=NULL WHERE id=?').run(now(), settings.id);

    const token = startSession(user.id, ctx.req);
    ctx.setCookie(sessionCookie(token));
    // A browser-driven IdP post wants a redirect; an API caller wants the body.
    const wantsJson = (ctx.req.headers.accept || '').includes('application/json');
    if (!wantsJson) { ctx.redirect(relay.startsWith('/') ? relay : '/'); return null; }
    return { signed_in: true, provider: 'saml', user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)),
             token, organization: { id: org.id, name: org.name }, relay_state: relay };
  });

  /** Domain ownership. The DNS lookup is real; a manual record says so. */
  r.post('/api/v1/domain-settings/:id/verify', async (ctx) => {
    const u = ctx.requireUser();
    const row = db.prepare('SELECT * FROM domain_settings WHERE id=?').get(ctx.params.id);
    if (!row) throw notFound('Domain not found');
    const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(row.organization_id);
    const role = db.prepare('SELECT * FROM organization_roles WHERE organization_id=? AND user_id=?').get(org.id, u.id);
    if (org.owner_id !== u.id && role?.role !== 'admin') throw forbidden('Organization admins only');

    const expected = `dochub-verify=${row.id.slice(0, 12)}`;
    if (process.env.DOCHUB_DOMAIN_VERIFY === 'manual') {
      db.prepare("UPDATE domain_settings SET verified=1, verified_method='manual-override', verified_at=? WHERE id=?")
        .run(now(), row.id);
      return { domain_setting: db.prepare('SELECT * FROM domain_settings WHERE id=?').get(row.id),
               verified: true, method: 'manual-override',
               note: 'DOCHUB_DOMAIN_VERIFY=manual is set: ownership was recorded without a DNS lookup.' };
    }
    const { resolveTxt } = await import('node:dns/promises');
    let records = [];
    try { records = (await resolveTxt(`_dochub.${row.domain_name}`)).map((parts) => parts.join('')); }
    catch (err) {
      return { domain_setting: row, verified: false, method: 'dns-txt',
               error: `DNS lookup for _dochub.${row.domain_name} failed: ${err.code || err.message}`,
               expected_record: expected };
    }
    const matched = records.includes(expected);
    if (matched) {
      db.prepare("UPDATE domain_settings SET verified=1, verified_method='dns-txt', verified_at=? WHERE id=?")
        .run(now(), row.id);
    }
    return { domain_setting: db.prepare('SELECT * FROM domain_settings WHERE id=?').get(row.id),
             verified: matched, method: 'dns-txt', expected_record: expected, found: records };
  });
}
