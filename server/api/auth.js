import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { badRequest, unauthorized, notFound, forbidden } from '../http.js';
import {
  createUser, convertGuest, getUserByEmail, getUser, startSession, endSession, verifyPassword,
  hashPassword, issueOtp, checkOtp, sessionCookie, clearCookie, clientIp,
} from '../auth.js';
import { entitlements, usageSnapshot, MATRIX, PLANS } from '../entitlements.js';
import { sendEmail, integrationStatus } from '../services.js';
import { providerStatus } from '../ai.js';

export const publicUser = (u) => u && ({
  id: u.id, email: u.email, name: u.name, avatar_color: u.avatar_color,
  is_guest: !!u.is_guest, provider: u.provider, plan: u.plan,
  plan_period: u.plan_period, organization_id: u.organization_id,
  otp_enabled: !!u.otp_enabled, accepted_site_policies: !!u.accepted_site_policies,
  locale: u.locale, created_at: u.created_at,
});

export default function mount(r) {
  // --- sessions -----------------------------------------------------------
  r.post('/api/v1/users/registrations/sign_up.json', async (ctx) => {
    const { email, password, name } = ctx.body;
    if (!email || !password) throw badRequest('Email and password are required');
    if (String(password).length < 8) throw badRequest('Password must be at least 8 characters');
    // Signing up from a guest session claims that session rather than starting
    // over, so work done before registering is not orphaned.
    const user = ctx.user?.is_guest
      ? convertGuest(ctx.user, { email, password, name })
      : createUser({ email, password, name });
    if (ctx.token) endSession(ctx.token);
    const token = startSession(user.id, ctx.req);
    await sendEmail(null, { to: email, subject: 'Welcome to DocHub', body: 'Your account is ready.', kind: 'welcome' });
    ctx.setCookie(sessionCookie(token));
    return { user: publicUser(user), token };
  });

  r.post('/api/v1/users/sessions/sign-in', async (ctx) => {
    const { email, password } = ctx.body;
    const user = getUserByEmail(email);
    if (!user || !verifyPassword(String(password || ''), user.password_hash, user.password_salt)) {
      throw unauthorized('Those credentials do not match an account');
    }
    const org = user.organization_id
      ? db.prepare('SELECT * FROM organizations WHERE id=?').get(user.organization_id) : null;
    if (org?.sso_enforced) {
      const settings = db.prepare('SELECT * FROM saml_settings WHERE organization_id=?').get(org.id);
      if (settings?.enabled && settings.idp_sso_url) {
        throw forbidden(`${org.name} requires single sign-on: start at /api/v1/saml/login`);
      }
    }
    if (user.otp_enabled) {
      const code = issueOtp(user.id);
      await sendEmail(null, { to: user.email, subject: 'Your DocHub code', body: `Code: ${code}`, kind: 'otp' });
      return { otp_required: true, user_id: user.id };
    }
    const token = startSession(user.id, ctx.req);
    ctx.setCookie(sessionCookie(token));
    return { user: publicUser(user), token };
  });

  r.post('/api/v1/users/otp/check-password', async (ctx) => {
    const { user_id, code } = ctx.body;
    if (!checkOtp(user_id, code)) throw unauthorized('That code is not valid');
    const token = startSession(user_id, ctx.req);
    ctx.setCookie(sessionCookie(token));
    return { user: publicUser(getUser(user_id)), token };
  });

  r.post('/api/v1/users/otp/send-current-otp-via-email', async (ctx) => {
    const u = ctx.requireUser();
    const code = issueOtp(u.id);
    await sendEmail(u, { to: u.email, subject: 'Your DocHub code', body: `Code: ${code}`, kind: 'otp' });
    return { sent: true };
  });

  r.post('/api/v1/users/otp/update-password', async (ctx) => {
    const u = ctx.requireUser();
    const { password } = ctx.body;
    if (String(password || '').length < 8) throw badRequest('Password must be at least 8 characters');
    const { salt, hash } = hashPassword(password);
    db.prepare('UPDATE users SET password_hash=?, password_salt=? WHERE id=?').run(hash, salt, u.id);
    return { updated: true };
  });

  r.post('/api/v1/users/otp/remove-other-device-sessions', async (ctx) => {
    const u = ctx.requireUser();
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, ctx.token || '');
    return { revoked: true };
  });

  r.post('/api/v1/users/send-reset-password-instructions', async (ctx) => {
    const u = getUserByEmail(ctx.body.email || '');
    // Always report success: existence of an account is not disclosed.
    if (u) {
      const code = issueOtp(u.id);
      await sendEmail(null, { to: u.email, subject: 'Reset your DocHub password', body: `Code: ${code}`, kind: 'reset' });
    }
    return { sent: true };
  });

  r.post('/api/v1/users/find-or-create-guest', async (ctx) => {
    const email = ctx.body.email || `guest-${randomUUID().slice(0, 8)}@guest.dochub.local`;
    const user = getUserByEmail(email) || createUser({ email, isGuest: true, provider: 'guest' });
    const token = startSession(user.id, ctx.req);
    ctx.setCookie(sessionCookie(token));
    return { user: publicUser(user), token };
  });

  r.post('/api/v1/users/sign-out', async (ctx) => {
    if (ctx.token) endSession(ctx.token);
    ctx.setCookie(clearCookie());
    return { signed_out: true };
  });

  // --- current user payload ----------------------------------------------
  r.get('/api/v1/users/current-user', async (ctx) => ({ user: publicUser(ctx.user) }));
  r.get('/api/v1/users/current-user-id', async (ctx) => ({ id: ctx.user?.id ?? null }));

  r.get('/api/v1/users/show-initial-payload', async (ctx) => {
    const u = ctx.user;
    if (!u) return { user: null, plans: MATRIX, plan_order: PLANS };
    const ent = entitlements(u);
    return {
      user: publicUser(u),
      entitlements: { plan: ent.plan, label: ent.label, features: ent.features, limits: ent.limits },
      usage: usageSnapshot(u),
      plans: MATRIX,
      plan_order: PLANS,
      integrations: integrationStatus(u),
      ai: providerStatus(),
      organization: u.organization_id
        ? db.prepare('SELECT * FROM organizations WHERE id=?').get(u.organization_id)
        : null,
      notifications: db.prepare(
        'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 25'
      ).all(u.id),
    };
  });

  r.post('/api/v1/users/accept-site-policies', async (ctx) => {
    const u = ctx.requireUser();
    db.prepare('UPDATE users SET accepted_site_policies=1 WHERE id=?').run(u.id);
    return { accepted: true };
  });
  r.get('/api/v1/users/did-accept-site-policies', async (ctx) =>
    ({ accepted: !!ctx.user?.accepted_site_policies }));

  r.patch('/api/v1/users/profile', async (ctx) => {
    const u = ctx.requireUser();
    const { name, locale, avatar_color } = ctx.body;
    db.prepare('UPDATE users SET name=COALESCE(?,name), locale=COALESCE(?,locale), avatar_color=COALESCE(?,avatar_color) WHERE id=?')
      .run(name ?? null, locale ?? null, avatar_color ?? null, u.id);
    return { user: publicUser(getUser(u.id)) };
  });

  r.post('/api/v1/users/otp/enable', async (ctx) => {
    const u = ctx.requireUser();
    db.prepare('UPDATE users SET otp_enabled=? WHERE id=?').run(ctx.body.enabled ? 1 : 0, u.id);
    return { otp_enabled: !!ctx.body.enabled };
  });

  r.get('/api/v1/login-activity', async (ctx) => {
    const u = ctx.requireUser();
    return { login_activity: db.prepare(
      'SELECT * FROM login_activity WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(u.id) };
  });

  r.get('/api/v1/sessions', async (ctx) => {
    const u = ctx.requireUser();
    return { sessions: db.prepare(
      'SELECT token, user_agent, ip, created_at, expires_at FROM sessions WHERE user_id=?').all(u.id)
      .map((s) => ({ ...s, token: s.token.slice(0, 8), current: s.token.startsWith((ctx.token || '').slice(0, 8)) })) };
  });

  // --- notifications ------------------------------------------------------
  r.post('/api/v1/notifications/:id/read', async (ctx) => {
    const u = ctx.requireUser();
    db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(ctx.params.id, u.id);
    return { read: true };
  });

  // --- static-ish endpoints observed in the bundle ------------------------
  r.get('/api/v1/static/revision_info', async () => ({
    revision: 'reconstruction', built_at: now(),
  }));
  r.get('/api/v1/statuspage/status', async () => ({ indicator: 'none', description: 'All systems operational' }));
  r.get('/api/v1/site/terms', async () => ({
    terms_url: '/terms', privacy_url: '/privacy', updated_at: '2026-01-01T00:00:00Z',
  }));
  r.get('/api/v1/geolocations/current-user-ip-country', async (ctx) =>
    ({ ip: clientIp(ctx.req), country: null, note: 'no geolocation provider configured' }));
  r.get('/api/v1/release-notes/latest', async () => {
    const row = db.prepare('SELECT * FROM documents WHERE 1=0').get?.();
    return { release_note: row ?? { title: 'DocHub reconstruction', body: 'Initial build.', created_at: now() } };
  });
}
