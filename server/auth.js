import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db, now } from './db.js';
import { HttpError, unauthorized } from './http.js';

const SESSION_DAYS = 30;
const COLORS = ['#2d7ff9', '#17b26a', '#f79009', '#f04438', '#7a5af8', '#0ba5ec', '#dd2590'];

export const hashPassword = (pw) => {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(pw, salt, 64).toString('hex') };
};

export const verifyPassword = (pw, hash, salt) => {
  if (!hash || !salt) return false;
  const a = Buffer.from(scryptSync(pw, salt, 64).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createUser({ email, name = '', password = null, isGuest = false, provider = 'password', plan = 'free' }) {
  const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase());
  if (existing) throw new HttpError(409, 'An account already exists for that email');
  const id = randomUUID();
  const { salt, hash } = password ? hashPassword(password) : { salt: null, hash: null };
  db.prepare(`INSERT INTO users (id,email,name,password_hash,password_salt,avatar_color,is_guest,provider,plan,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, email.toLowerCase(), name || email.split('@')[0], hash, salt,
         COLORS[Math.floor(Math.random() * COLORS.length)], isGuest ? 1 : 0, provider, plan, now());
  return getUser(id);
}

/** Claim a guest session as a real account: the row keeps its id, so every
 *  document, folder and signature the guest already made carries over. */
export function convertGuest(guest, { email, name = '', password }) {
  const taken = db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(email.toLowerCase(), guest.id);
  if (taken) throw new HttpError(409, 'An account already exists for that email');
  const { salt, hash } = hashPassword(password);
  db.prepare(`UPDATE users SET email=?, name=?, password_hash=?, password_salt=?,
                is_guest=0, provider='password' WHERE id=?`)
    .run(email.toLowerCase(), name || guest.name || email.split('@')[0], hash, salt, guest.id);
  return getUser(guest.id);
}

export const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id) || null;
export const getUserByEmail = (email) => db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase()) || null;

export function startSession(userId, req) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token,user_id,user_agent,ip,created_at,expires_at) VALUES (?,?,?,?,?,?)')
    .run(token, userId, req?.headers?.['user-agent'] || '', clientIp(req), now(), expires);
  db.prepare('INSERT INTO login_activity (id,user_id,kind,ip,user_agent,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), userId, 'sign_in', clientIp(req), req?.headers?.['user-agent'] || '', now());
  return token;
}

export const endSession = (token) => db.prepare('DELETE FROM sessions WHERE token=?').run(token);

export function userFromRequest(req) {
  const token = cookie(req, 'dh_session') || bearer(req);
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s || s.expires_at < now()) return null;
  const u = getUser(s.user_id);
  if (u) db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(now(), u.id);
  return u;
}

/** Sliding expiry: a session in active use keeps moving its own deadline out,
 *  so returning to the tab is enough to keep guest work reachable. Returns a
 *  fresh cookie when the deadline actually moved, otherwise null. */
export function renewSession(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s || s.expires_at < now()) return null;
  const full = SESSION_DAYS * 864e5;
  if (new Date(s.expires_at).getTime() - Date.now() > full / 2) return null;
  db.prepare('UPDATE sessions SET expires_at=? WHERE token=?')
    .run(new Date(Date.now() + full).toISOString(), token);
  return sessionCookie(token);
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

export const clientIp = (req) =>
  (req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req?.socket?.remoteAddress || '';

export function cookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

export const sessionCookie = (token) =>
  `dh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => 'dh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

/** 6-digit one-time code, stored hashed against the user row. */
export function issueOtp(userId) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('UPDATE users SET otp_secret=? WHERE id=?').run(sha256(code), userId);
  return code;
}
export function checkOtp(userId, code) {
  const u = getUser(userId);
  const ok = !!u?.otp_secret && u.otp_secret === sha256(String(code));
  if (ok) db.prepare('UPDATE users SET otp_secret=NULL WHERE id=?').run(userId);
  return ok;
}
