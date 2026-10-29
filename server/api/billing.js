import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { MATRIX, PLANS, entitlements, usageSnapshot } from '../entitlements.js';
import { sendEmail } from '../services.js';
import {
  PROVIDER as STRIPE_PROVIDER, isStripe, stripeStatus, stripeCall, verifyWebhook,
  priceId, planForPrice,
} from '../stripe.js';
import { publicUser } from './auth.js';

/** Two payment modes. `internal-test` (the default) applies plan changes
 *  locally and labels every artifact so nothing reads as a real charge;
 *  `stripe` creates a real Checkout Session and lets the webhook move the
 *  plan, so nothing is granted before Stripe says it was paid for. */
const PROVIDER = STRIPE_PROVIDER;

/** Shared by the webhook and the invoice sync. */
function applyStripeSubscription(user, { plan, period, subscriptionId, customerId, seats = 1, periodEnd = null, state = 'active' }) {
  const existing = db.prepare('SELECT * FROM subscriptions WHERE external_id=?').get(subscriptionId);
  const id = existing?.id || randomUUID();
  if (existing) {
    db.prepare(`UPDATE subscriptions SET plan=?, period=?, state=?, seats=?, current_period_end=?,
                external_customer_id=? WHERE id=?`)
      .run(plan, period, state, seats, periodEnd, customerId ?? null, id);
  } else {
    db.prepare(`INSERT INTO subscriptions (id,user_id,plan,period,state,seats,provider,external_id,
                external_customer_id,current_period_end,created_at)
                VALUES (?,?,?,?,?,?,'stripe',?,?,?,?)`)
      .run(id, user.id, plan, period, state, seats, subscriptionId, customerId ?? null, periodEnd, now());
  }
  if (state === 'active' || state === 'trialing') {
    db.prepare('UPDATE users SET plan=?, plan_period=?, plan_renews_at=? WHERE id=?')
      .run(plan, period, periodEnd, user.id);
  } else {
    db.prepare("UPDATE users SET plan='free', plan_renews_at=NULL WHERE id=?").run(user.id);
  }
  return db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
}

function upsertInvoice(userId, inv, subscriptionId = null) {
  const existing = db.prepare('SELECT * FROM invoices WHERE external_id=?').get(inv.id);
  const id = existing?.id || randomUUID();
  const number = inv.number || `STRIPE-${String(inv.id).slice(-8).toUpperCase()}`;
  if (existing) {
    db.prepare('UPDATE invoices SET amount_cents=?, currency=?, state=?, number=?, hosted_url=? WHERE id=?')
      .run(inv.amount_paid ?? inv.amount_due ?? 0, inv.currency || 'usd', inv.status || 'open',
           number, inv.hosted_invoice_url ?? null, id);
  } else {
    db.prepare(`INSERT INTO invoices (id,user_id,subscription_id,amount_cents,currency,state,number,
                external_id,hosted_url,provider,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,'stripe',?)`)
      .run(id, userId, subscriptionId, inv.amount_paid ?? inv.amount_due ?? 0, inv.currency || 'usd',
           inv.status || 'open', number, inv.id, inv.hosted_invoice_url ?? null,
           inv.created ? new Date(inv.created * 1000).toISOString() : now());
  }
  return db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
}

async function stripeCustomerFor(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await stripeCall('POST', 'customers',
    { email: user.email, name: user.name || undefined, metadata: { dochub_user_id: user.id } });
  db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(customer.id, user.id);
  return customer.id;
}

export default function mount(r) {
  r.get('/api/v1/stripe-plans', async () => ({
    plans: PLANS.map((p) => ({
      id: p, label: MATRIX[p].label,
      price_month: MATRIX[p].price_month, price_year: MATRIX[p].price_year,
      features: MATRIX[p].features, limits: Object.fromEntries(
        Object.entries(MATRIX[p].limits).map(([k, v]) => [k, v === Infinity ? null : v])),
    })),
    provider: PROVIDER,
    payment: stripeStatus(),
  }));
  r.get('/api/v1/braintree-plans', async () => ({ plans: [], provider: PROVIDER, note: 'Braintree is not configured' }));

  r.get('/api/v1/pro-subscriptions', async (ctx) => {
    const u = ctx.requireUser();
    return {
      subscriptions: db.prepare('SELECT * FROM subscriptions WHERE user_id=? ORDER BY created_at DESC').all(u.id),
      current: entitlements(u),
      usage: usageSnapshot(u),
    };
  });

  r.post('/api/v1/pro-subscriptions/create-free-subscription', async (ctx) => {
    const u = ctx.requireUser();
    db.prepare("UPDATE users SET plan='free' WHERE id=?").run(u.id);
    return { plan: 'free' };
  });

  r.post('/api/v1/stripe-checkout/create-checkout-session-with-subscription', async (ctx) => {
    const u = ctx.requireUser();
    const plan = String(ctx.body.plan || '');
    const periodChoice = ctx.body.period === 'yearly' ? 'yearly' : 'monthly';
    const seats = Math.max(1, Number(ctx.body.seats) || 1);
    if (!PLANS.includes(plan)) throw badRequest('Unknown plan');
    if (plan === 'site_license') {
      return { checkout_required: false, note: 'Site License is custom-priced; use the enquiry form.' };
    }

    if (isStripe()) {
      const price = priceId(plan, periodChoice);
      if (!price) {
        throw badRequest(`No Stripe price is configured for ${plan}/${periodChoice}: `
          + `set DOCHUB_STRIPE_PRICE_${plan.toUpperCase()}_${periodChoice.toUpperCase()}`);
      }
      const base = process.env.DOCHUB_BASE_URL || `http://${ctx.req.headers.host || 'localhost:4173'}`;
      const customer = await stripeCustomerFor(u);
      const session = await stripeCall('POST', 'checkout/sessions', {
        mode: 'subscription',
        customer,
        client_reference_id: u.id,
        line_items: [{ price, quantity: seats }],
        success_url: `${base}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/settings/billing?checkout=cancelled`,
        metadata: { dochub_user_id: u.id, plan, period: periodChoice },
        subscription_data: { metadata: { dochub_user_id: u.id, plan, period: periodChoice } },
      });
      // The plan is NOT changed here: only the webhook, after Stripe confirms
      // payment, moves the subscription and the user's plan.
      return {
        checkout_required: true, applied: false, provider: 'stripe',
        checkout_url: session.url, session_id: session.id,
        note: 'Complete the Stripe Checkout session. Your plan changes when the '
          + 'checkout.session.completed webhook arrives.',
      };
    }

    if (PROVIDER !== 'internal-test') {
      throw badRequest(`Unknown payment provider "${PROVIDER}": set DOCHUB_PAYMENT_PROVIDER to stripe or internal-test`);
    }
    // Apply the plan change locally and record a test-mode invoice.
    const subId = randomUUID();
    const endsAt = new Date(Date.now() + (periodChoice === 'yearly' ? 365 : 30) * 864e5).toISOString();
    db.prepare(`INSERT INTO subscriptions (id,user_id,plan,period,state,seats,provider,current_period_end,created_at)
                VALUES (?,?,?,?,'active',?,?,?,?)`)
      .run(subId, u.id, plan, periodChoice, seats, PROVIDER, endsAt, now());
    db.prepare('UPDATE users SET plan=?, plan_period=?, plan_renews_at=? WHERE id=?')
      .run(plan, periodChoice, endsAt, u.id);
    const amount = (periodChoice === 'yearly' ? MATRIX[plan].price_year : MATRIX[plan].price_month) * 100;
    const invId = randomUUID();
    db.prepare(`INSERT INTO invoices (id,user_id,subscription_id,amount_cents,currency,state,number,provider,created_at)
                VALUES (?,?,?,?,'usd','paid',?,?,?)`)
      .run(invId, u.id, subId, amount, `TEST-${invId.slice(0, 8).toUpperCase()}`, PROVIDER, now());
    await sendEmail(u, { to: u.email, kind: 'receipt', subject: `DocHub ${MATRIX[plan].label} activated`,
                   body: `Test-mode subscription. Amount recorded: $${(amount / 100).toFixed(2)}.` });
    return {
      checkout_required: false, applied: true, provider: PROVIDER,
      subscription: db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId),
      user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)),
      note: 'No real payment was taken: this deployment has no payment provider.',
    };
  });

  /** Stripe webhook. The signature is checked against the raw request body. */
  r.post('/api/v1/stripe-webhook', async (ctx) => {
    if (!isStripe()) throw badRequest('This deployment is not in Stripe mode');
    let event;
    try { event = verifyWebhook(ctx.rawBody ?? Buffer.alloc(0), ctx.req.headers['stripe-signature']); }
    catch (err) { throw badRequest(`Webhook rejected: ${err.message}`); }

    const object = event.data?.object || {};
    const userOf = (id, customerId) =>
      (id && db.prepare('SELECT * FROM users WHERE id=?').get(id))
      || (customerId && db.prepare('SELECT * FROM users WHERE stripe_customer_id=?').get(customerId))
      || null;

    switch (event.type) {
      case 'checkout.session.completed': {
        const user = userOf(object.metadata?.dochub_user_id || object.client_reference_id, object.customer);
        if (!user) return { received: true, applied: false, reason: 'no user matches this checkout session' };
        const sub = object.subscription
          ? await stripeCall('GET', `subscriptions/${object.subscription}`)
          : null;
        const mapped = planForPrice(sub?.items?.data?.[0]?.price?.id, PLANS)
          || { plan: object.metadata?.plan, period: object.metadata?.period || 'monthly' };
        if (!PLANS.includes(mapped.plan)) {
          return { received: true, applied: false, reason: `could not map the purchased price to a plan` };
        }
        const subscription = applyStripeSubscription(user, {
          plan: mapped.plan, period: mapped.period,
          subscriptionId: sub?.id || object.subscription || object.id,
          customerId: object.customer, seats: sub?.items?.data?.[0]?.quantity || 1,
          periodEnd: sub?.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          state: sub?.status || 'active',
        });
        await sendEmail(user, { to: user.email, kind: 'receipt',
          subject: `DocHub ${MATRIX[mapped.plan].label} activated`,
          body: `Your Stripe subscription ${subscription.external_id} is active.` });
        return { received: true, applied: true, plan: mapped.plan, subscription_id: subscription.id };
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const user = userOf(object.metadata?.dochub_user_id, object.customer);
        if (!user) return { received: true, applied: false, reason: 'no user matches this subscription' };
        const mapped = planForPrice(object.items?.data?.[0]?.price?.id, PLANS)
          || { plan: object.metadata?.plan || 'free', period: object.metadata?.period || 'monthly' };
        const ended = event.type === 'customer.subscription.deleted'
          || ['canceled', 'incomplete_expired', 'unpaid'].includes(object.status);
        const subscription = applyStripeSubscription(user, {
          plan: ended ? 'free' : mapped.plan, period: mapped.period,
          subscriptionId: object.id, customerId: object.customer,
          seats: object.items?.data?.[0]?.quantity || 1,
          periodEnd: object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null,
          state: ended ? 'canceled' : (object.status || 'active'),
        });
        return { received: true, applied: true, state: subscription.state,
                 plan: db.prepare('SELECT plan FROM users WHERE id=?').get(user.id).plan };
      }
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.finalized': {
        const user = userOf(object.metadata?.dochub_user_id, object.customer);
        if (!user) return { received: true, applied: false, reason: 'no user matches this invoice' };
        const sub = object.subscription
          ? db.prepare('SELECT * FROM subscriptions WHERE external_id=?').get(object.subscription) : null;
        const invoice = upsertInvoice(user.id, object, sub?.id ?? null);
        return { received: true, applied: true, invoice_id: invoice.id, state: invoice.state };
      }
      default:
        return { received: true, applied: false, reason: `${event.type} is not handled by this deployment` };
    }
  });

  /** Pull invoices back from Stripe so the billing page is not guessing. */
  r.post('/api/v1/stripe-invoices/sync', async (ctx) => {
    const u = ctx.requireUser();
    if (!isStripe()) {
      return { synced: 0, provider: PROVIDER,
               note: 'Invoice sync needs Stripe mode; the invoices listed here were written locally.' };
    }
    if (!u.stripe_customer_id) return { synced: 0, provider: 'stripe', note: 'No Stripe customer exists for this account yet.' };
    const out = await stripeCall('GET', `invoices?customer=${encodeURIComponent(u.stripe_customer_id)}&limit=100`);
    let synced = 0;
    for (const inv of out.data || []) {
      const sub = inv.subscription
        ? db.prepare('SELECT * FROM subscriptions WHERE external_id=?').get(inv.subscription) : null;
      upsertInvoice(u.id, inv, sub?.id ?? null);
      synced++;
    }
    return { synced, provider: 'stripe',
             invoices: db.prepare('SELECT * FROM invoices WHERE user_id=? ORDER BY created_at DESC').all(u.id) };
  });

  r.post('/api/v1/pro-subscriptions/cancel', async (ctx) => {
    const u = ctx.requireUser();
    const active = db.prepare("SELECT * FROM subscriptions WHERE user_id=? AND state='active' ORDER BY created_at DESC").get(u.id);
    if (isStripe() && active?.external_id) {
      const atPeriodEnd = ctx.body.immediately !== true;
      const sub = atPeriodEnd
        ? await stripeCall('POST', `subscriptions/${active.external_id}`, { cancel_at_period_end: true })
        : await stripeCall('DELETE', `subscriptions/${active.external_id}`);
      if (!atPeriodEnd) {
        db.prepare("UPDATE subscriptions SET state='canceled' WHERE id=?").run(active.id);
        db.prepare("UPDATE users SET plan='free', plan_renews_at=NULL WHERE id=?").run(u.id);
      }
      return { provider: 'stripe', canceled: !atPeriodEnd, cancel_at_period_end: atPeriodEnd,
               stripe_status: sub.status,
               plan: db.prepare('SELECT plan FROM users WHERE id=?').get(u.id).plan,
               note: atPeriodEnd
                 ? 'Stripe will not renew this subscription; the plan stays active until the period ends.'
                 : 'The Stripe subscription was cancelled immediately and the plan dropped to Free.' };
    }
    db.prepare("UPDATE subscriptions SET state='canceled' WHERE user_id=? AND state='active'").run(u.id);
    db.prepare("UPDATE users SET plan='free', plan_renews_at=NULL WHERE id=?").run(u.id);
    return { plan: 'free', canceled: true, provider: PROVIDER };
  });

  r.get('/api/v1/stripe-invoices', async (ctx) => {
    const u = ctx.requireUser();
    return { invoices: db.prepare('SELECT * FROM invoices WHERE user_id=? ORDER BY created_at DESC').all(u.id) };
  });

  r.post('/api/v1/stripe-invoices/preview', async (ctx) => {
    const u = ctx.requireUser();
    const plan = String(ctx.body.plan || '');
    if (!MATRIX[plan]) throw badRequest('Unknown plan');
    const yearly = ctx.body.period === 'yearly';
    const price = yearly ? MATRIX[plan].price_year : MATRIX[plan].price_month;
    return { preview: { plan, period: yearly ? 'yearly' : 'monthly', amount_cents: (price ?? 0) * 100,
                        currency: 'usd', provider: PROVIDER,
                        stripe_price_id: isStripe() ? priceId(plan, yearly ? 'yearly' : 'monthly') : null } };
  });

  r.get('/api/v1/billing-addresses', async (ctx) => {
    const u = ctx.requireUser();
    return { billing_address: db.prepare('SELECT * FROM billing_addresses WHERE 1=0').get?.() ?? null };
  });

  r.get('/api/v1/pricing-visits', async () => ({ recorded: true }));
  r.post('/api/v1/pricing-visits', async (ctx) => {
    const u = ctx.user;
    if (u) db.prepare(`INSERT INTO usage_events (id,user_id,metric,amount,period,created_at)
                       VALUES (?,?,'pricing_visit',1,?,?)`)
      .run(randomUUID(), u.id, now().slice(0, 7), now());
    return { recorded: true };
  });

  r.get('/api/v1/paywall-events', async (ctx) => {
    const u = ctx.requireUser();
    return { paywall_events: db.prepare(
      'SELECT * FROM paywall_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(u.id) };
  });
}
