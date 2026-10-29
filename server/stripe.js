// Stripe over the REST API with fetch -- no SDK. Only reached when
// DOCHUB_PAYMENT_PROVIDER=stripe and DOCHUB_STRIPE_SECRET_KEY is set.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PROVIDER = process.env.DOCHUB_PAYMENT_PROVIDER || 'internal-test';
export const isStripe = () => PROVIDER === 'stripe';
export const secretKey = () => process.env.DOCHUB_STRIPE_SECRET_KEY || null;
export const webhookSecret = () => process.env.DOCHUB_STRIPE_WEBHOOK_SECRET || null;
export const apiBase = () => process.env.DOCHUB_STRIPE_API_BASE || 'https://api.stripe.com';

/** Price ids, one per plan+period, e.g. DOCHUB_STRIPE_PRICE_PRO_MONTHLY. */
export const priceId = (plan, period) =>
  process.env[`DOCHUB_STRIPE_PRICE_${plan.toUpperCase()}_${period.toUpperCase()}`] || null;

export function stripeStatus() {
  if (!isStripe()) return { provider: PROVIDER, live: false };
  const key = secretKey();
  return {
    provider: 'stripe',
    live: !!key,
    key_mode: key ? (key.startsWith('sk_live') ? 'live' : 'test') : null,
    webhook_configured: !!webhookSecret(),
    missing: [!key && 'DOCHUB_STRIPE_SECRET_KEY', !webhookSecret() && 'DOCHUB_STRIPE_WEBHOOK_SECRET']
      .filter(Boolean),
  };
}

/** Flatten nested objects/arrays into Stripe's form-encoding. */
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object'
      ? formEncode(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripeCall(method, path, body) {
  const key = secretKey();
  if (!key) throw new Error('DOCHUB_STRIPE_SECRET_KEY is not set');
  const res = await fetch(`${apiBase()}/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'stripe-version': process.env.DOCHUB_STRIPE_API_VERSION || '2024-06-20',
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? formEncode(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* surfaced below */ }
  if (!res.ok) throw new Error(json?.error?.message || `Stripe returned ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

/** Verify a Stripe-Signature header against the raw request body. */
export function verifyWebhook(rawBody, header, { toleranceSeconds = 300 } = {}) {
  const secret = webhookSecret();
  if (!secret) throw new Error('DOCHUB_STRIPE_WEBHOOK_SECRET is not set');
  if (!header) throw new Error('missing Stripe-Signature header');
  const parts = Object.create(null);
  const v1 = [];
  for (const piece of String(header).split(',')) {
    const [k, v] = piece.split('=');
    if (k?.trim() === 'v1') v1.push(v.trim()); else if (k) parts[k.trim()] = v?.trim();
  }
  if (!parts.t || !v1.length) throw new Error('malformed Stripe-Signature header');
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > toleranceSeconds) throw new Error('webhook timestamp is outside the tolerance');
  const expected = createHmac('sha256', secret)
    .update(`${parts.t}.${Buffer.from(rawBody).toString('utf8')}`, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const matched = v1.some((sig) => {
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!matched) throw new Error('webhook signature does not match');
  return JSON.parse(Buffer.from(rawBody).toString('utf8'));
}

/** Reverse of priceId(): which plan+period a Stripe price belongs to. */
export function planForPrice(id, plans) {
  for (const plan of plans) {
    for (const period of ['monthly', 'yearly']) {
      if (id && priceId(plan, period) === id) return { plan, period };
    }
  }
  return null;
}
