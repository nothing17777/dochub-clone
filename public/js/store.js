import { get, post, setPaywallHandler } from './api.js';
import { modal, h, toast } from './ui.js';

export const state = {
  user: null, entitlements: null, usage: null, plans: null, planOrder: [],
  integrations: [], ai: null, organization: null, notifications: [],
  cable: null,
};

export async function refresh() {
  const p = await get('/api/v1/users/show-initial-payload');
  state.user = p.user;
  state.entitlements = p.entitlements || null;
  state.usage = p.usage || null;
  state.plans = p.plans; state.planOrder = p.plan_order || [];
  state.integrations = p.integrations || [];
  state.ai = p.ai || null;
  state.organization = p.organization || null;
  state.notifications = p.notifications || [];
  return state;
}

/** Anonymous use: the server hands out a guest session with the free plan. */
export async function startGuest() {
  await post('/api/v1/users/find-or-create-guest', {});
  return refresh();
}

export const can = (feature) => !!state.entitlements?.features?.[feature];
export const limitOf = (metric) => state.entitlements?.limits?.[metric];
export const planLabel = () => state.entitlements?.label || 'Free';

/** Lowest plan in the matrix that enables a feature. */
export function requiredPlanFor(feature) {
  for (const p of state.planOrder) if (state.plans?.[p]?.features?.[feature]) return p;
  return 'site_license';
}

export function showPaywall({ message, feature, required_plan }) {
  const plan = state.plans?.[required_plan];
  modal({
    title: 'Upgrade to continue',
    body: h('div', {},
      h('p', {}, message),
      plan ? h('p', { class: 'sub' }, `Available on ${plan.label}` +
        (plan.price_month != null ? ` — $${plan.price_month}/mo, or $${plan.price_year}/yr.` : ' (custom pricing).')) : null,
      h('div', { class: 'note' }, 'This deployment has no payment provider: choosing a plan applies it locally and records a test-mode invoice.')),
    footer: [
      h('button', { class: 'btn ghost', onclick: () => document.querySelector('.backdrop')?.remove() }, 'Not now'),
      h('a', { class: 'btn primary', href: '#/pricing',
               onclick: () => document.querySelector('.backdrop')?.remove() }, 'See plans'),
    ],
  });
}
setPaywallHandler(showPaywall);

/** Server-sent events; the production app uses ActionCable for the same job. */
export function connectCable(documentId, handlers = {}) {
  state.cable?.close();
  const url = `/api/cable${documentId ? `?document_id=${encodeURIComponent(documentId)}` : ''}`;
  const es = new EventSource(url);
  state.cable = es;
  for (const [event, fn] of Object.entries(handlers)) es.addEventListener(event, (e) => {
    try { fn(JSON.parse(e.data)); } catch { fn({}); }
  });
  es.addEventListener('notification', (e) => {
    try { const n = JSON.parse(e.data); state.notifications.unshift(n); toast(n.body); } catch {}
  });
  return es;
}
