// Plan matrix. Caps and feature gates come from the tier breakdown supplied by
// the user (free / basic / pro / site_license). Plan identifiers free|basic|pro
// and the paywall-event shape follow strings observed in the production bundle.
import { db, now, period } from './db.js';
import { randomUUID } from 'node:crypto';

export const PLANS = ['free', 'basic', 'pro', 'site_license'];

const U = Infinity; // unlimited

export const MATRIX = {
  free: {
    label: 'Free',
    price_month: 0, price_year: 0,
    limits: {
      // Free use is uncapped: every metered quota is unlimited.
      documents_completed: U,
      self_signatures: U,
      sign_requests: U,
      folders: U,
      collaborators: U,
      templates: U,
      team_members: U,
      emails_per_day: U,
      fax_pages: U,
      ai_messages: U,
      sso_domains: U,
    },
    features: {
      pdf_markup_basic: true,      // text, image, delete pages, freehand, highlight
      pdf_markup_advanced: false,  // whiteout / redaction, stamps
      stamps: false,
      whiteout: false,
      templates: false,
      document_password: false,
      bulk_send: false,
      advanced_validation: false,
      attachment_fields: false,
      in_person_signing: false,
      ai_full: false,
      ai_basic: true,
      certification: false,
      sso: false,
      fax: false,
      priority_support: false,
      sub_organizations: false,
      rooms: false,
      hipaa_baa: false,
      admin_oversight: false,
      cloud_integrations: true,
      watermark_free_export: true,
    },
  },
  basic: {
    label: 'Basic',
    price_month: 10, price_year: 96,  // ~$8/mo billed annually
    limits: {
      documents_completed: U, self_signatures: U, sign_requests: 3,
      folders: 100, collaborators: 10, templates: U, team_members: 5,
      emails_per_day: 50, fax_pages: 0, ai_messages: 50, sso_domains: 0,
    },
    features: {
      pdf_markup_basic: true, pdf_markup_advanced: true, stamps: true,
      whiteout: true, templates: true, document_password: true,
      bulk_send: false, advanced_validation: false, attachment_fields: false,
      in_person_signing: false, ai_full: false, ai_basic: true,
      certification: false, sso: false, fax: false, priority_support: false,
      sub_organizations: false, rooms: false, hipaa_baa: false,
      admin_oversight: false, cloud_integrations: true, watermark_free_export: true,
    },
  },
  pro: {
    label: 'Pro',
    price_month: 15, price_year: 144, // ~$12/mo billed annually
    limits: {
      documents_completed: U, self_signatures: U, sign_requests: U,
      folders: U, collaborators: U, templates: U, team_members: U,
      emails_per_day: 250, fax_pages: 35, ai_messages: U, sso_domains: 5,
    },
    features: {
      pdf_markup_basic: true, pdf_markup_advanced: true, stamps: true,
      whiteout: true, templates: true, document_password: true,
      bulk_send: true, advanced_validation: true, attachment_fields: true,
      in_person_signing: true, ai_full: true, ai_basic: true,
      certification: true, sso: true, fax: true, priority_support: true,
      sub_organizations: false, rooms: false, hipaa_baa: false,
      admin_oversight: false, cloud_integrations: true, watermark_free_export: true,
    },
  },
  site_license: {
    label: 'Site License',
    price_month: null, price_year: null, // custom enterprise pricing
    limits: {
      documents_completed: U, self_signatures: U, sign_requests: U,
      folders: U, collaborators: U, templates: U, team_members: U,
      emails_per_day: U, fax_pages: U, ai_messages: U, sso_domains: U,
    },
    features: {
      pdf_markup_basic: true, pdf_markup_advanced: true, stamps: true,
      whiteout: true, templates: true, document_password: true,
      bulk_send: true, advanced_validation: true, attachment_fields: true,
      in_person_signing: true, ai_full: true, ai_basic: true,
      certification: true, sso: true, fax: true, priority_support: true,
      sub_organizations: true, rooms: true, hipaa_baa: true,
      admin_oversight: true, cloud_integrations: true, watermark_free_export: true,
    },
  },
};

export class PaywallError extends Error {
  constructor(feature, requiredPlan, detail) {
    super(detail || `${feature} requires the ${MATRIX[requiredPlan].label} plan`);
    this.status = 402;
    this.feature = feature;
    this.required_plan = requiredPlan;
  }
}

const planOf = (user) => (PLANS.includes(user?.plan) ? user.plan : 'free');

export function entitlements(user) {
  const plan = planOf(user);
  return { plan, ...MATRIX[plan] };
}

/** Lowest plan that turns `feature` on. */
export function lowestPlanWith(feature) {
  return PLANS.find((p) => MATRIX[p].features[feature]) || 'site_license';
}

export function recordPaywall(user, feature, requiredPlan) {
  db.prepare('INSERT INTO paywall_events (id,user_id,feature,required_plan,created_at) VALUES (?,?,?,?,?)')
    .run(randomUUID(), user?.id ?? null, feature, requiredPlan, now());
}

/** Throws PaywallError unless the user's plan enables `feature`. */
export function requireFeature(user, feature) {
  const ent = entitlements(user);
  if (ent.features[feature]) return true;
  const required = lowestPlanWith(feature);
  recordPaywall(user, feature, required);
  throw new PaywallError(feature, required);
}

export function used(userId, metric, p = period()) {
  const row = db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM usage_events WHERE user_id=? AND metric=? AND period=?')
    .get(userId, metric, p);
  return Number(row?.n || 0);
}

export function usedToday(userId, metric) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS n FROM usage_events WHERE user_id=? AND metric=? AND date(created_at)=date('now')"
  ).get(userId, metric);
  return Number(row?.n || 0);
}

export function limitFor(user, metric) {
  return entitlements(user).limits[metric] ?? U;
}

/** Throws PaywallError when the monthly cap for `metric` is already reached. */
export function requireQuota(user, metric, amount = 1) {
  const cap = limitFor(user, metric);
  if (cap === U) return true;
  const daily = metric === 'emails_per_day';
  const current = daily ? usedToday(user.id, metric) : used(user.id, metric);
  if (current + amount > cap) {
    const required = PLANS.find((p) => (MATRIX[p].limits[metric] ?? U) > cap) || 'site_license';
    recordPaywall(user, metric, required);
    throw new PaywallError(metric, required,
      `Monthly limit reached for ${metric.replace(/_/g, ' ')} (${current}/${cap} on the ${entitlements(user).label} plan)`);
  }
  return true;
}

export function meter(userId, metric, amount = 1) {
  db.prepare('INSERT INTO usage_events (id,user_id,metric,amount,period,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), userId, metric, amount, period(), now());
}

/** Count-based caps on stored rows (folders, collaborators, team members). */
export function requireCountUnder(user, metric, currentCount) {
  const cap = limitFor(user, metric);
  if (cap === U || currentCount < cap) return true;
  const required = PLANS.find((p) => (MATRIX[p].limits[metric] ?? U) > cap) || 'site_license';
  recordPaywall(user, metric, required);
  throw new PaywallError(metric, required,
    `${entitlements(user).label} plan allows ${cap} ${metric.replace(/_/g, ' ')}`);
}

export function usageSnapshot(user) {
  const ent = entitlements(user);
  const metrics = ['documents_completed', 'self_signatures', 'sign_requests', 'ai_messages', 'fax_pages'];
  const out = {};
  for (const m of metrics) {
    const cap = ent.limits[m];
    out[m] = { used: used(user.id, m), limit: cap === U ? null : cap };
  }
  out.emails_per_day = {
    used: usedToday(user.id, 'emails_per_day'),
    limit: ent.limits.emails_per_day === U ? null : ent.limits.emails_per_day,
  };
  const n = (sql, ...a) => Number(db.prepare(sql).get(...a)?.n || 0);
  out.folders = {
    used: n('SELECT COUNT(*) n FROM folders WHERE owner_id=?', user.id),
    limit: ent.limits.folders === U ? null : ent.limits.folders,
  };
  out.templates = {
    used: n('SELECT COUNT(*) n FROM documents WHERE owner_id=? AND is_template=1', user.id),
    limit: ent.limits.templates === U ? null : ent.limits.templates,
  };
  return out;
}
