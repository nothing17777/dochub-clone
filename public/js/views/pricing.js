import { h, clear, toast, modal, add } from '../ui.js';
import { get, post } from '../api.js';
import { state, refresh } from '../store.js';

const HIGHLIGHTS = {
  free: ['3 completed documents / month', '5 self-signatures / month', '3 signature requests / month',
         'Text, images, freehand, highlight', '3 folders, 2 collaborators', 'Basic AI assistant',
         'Google Drive, Gmail, Dropbox, OneDrive, Box, Classroom', 'No watermarks'],
  basic: ['Unlimited completions & downloads', 'Unlimited self-signing', 'Whiteout / redaction',
          '600 stamps', 'Unlimited templates, 100 folders', 'Teams up to 5, 10 collaborators',
          'Document password protection'],
  pro: ['Unlimited signature requests & envelopes', 'Full DocHub Intelligence suite',
        'Bulk send / mail merge', 'Advanced field validation & attachments', 'In-person signing',
        '250 emails/day, 35 fax pages/month', 'SSO across 5 domains', 'Document certification',
        'Priority support'],
  site_license: ['Unlimited users', 'Custom sub-organizations', 'Digital rooms',
                 'HIPAA BAA available', 'Advanced admin oversight', 'Strict SSO settings',
                 'Deployment assistance'],
};

const NOT_INCLUDED = {
  free: ['Whiteout & stamps', 'Templates', 'Password protection', 'Bulk send', 'In-person signing', 'Fax', 'SSO'],
  basic: ['Bulk send', 'In-person signing', 'Fax', 'SSO', 'Certification', 'Unlimited signature requests'],
  pro: ['Sub-organizations', 'Digital rooms', 'HIPAA BAA'],
  site_license: [],
};

export function pricing(navigate) {
  const root = h('div', { class: 'main' });
  let period = 'yearly';

  async function render() {
    const { plans } = await get('/api/v1/stripe-plans');
    clear(root);
    add(root, 
      h('div', { class: 'hero', style: { padding: '28px 0 20px' } },
        h('h1', { style: { fontSize: '30px' } }, 'Plans for every workflow'),
        h('p', {}, 'Edit, sign and send documents. Upgrade when the free allowances run out.'),
        h('div', { class: 'tabs', style: { justifyContent: 'center' } },
          h('button', { class: period === 'monthly' ? 'on' : '', onclick: () => { period = 'monthly'; render(); } }, 'Monthly'),
          h('button', { class: period === 'yearly' ? 'on' : '', onclick: () => { period = 'yearly'; render(); } }, 'Annual'))),
      h('div', { class: 'plans' }, ...plans.map((p) => planCard(p))),
      h('div', { class: 'note', style: { maxWidth: '760px', margin: '24px auto' } },
        'This deployment has no payment provider. Choosing a plan applies it immediately and records a '
        + 'test-mode invoice so the entitlement system can be exercised — no card is charged.'));
  }

  function planCard(p) {
    const isCurrent = state.user?.plan === p.id;
    const price = period === 'yearly' ? p.price_year : p.price_month;
    return h('div', { class: `plan ${p.id === 'pro' ? 'featured' : ''}` },
      h('h3', {}, p.label),
      p.id === 'pro' ? h('span', { class: 'badge info' }, 'Most popular') : null,
      h('div', { class: 'price', style: { margin: '10px 0' } },
        price == null ? 'Custom' : `$${period === 'yearly' ? (price / 12).toFixed(0) : price}`,
        price == null ? null : h('small', {}, period === 'yearly' ? '/mo billed annually' : '/mo')),
      price ? h('p', { class: 'sub', style: { marginTop: '-6px' } },
        period === 'yearly' ? `$${price} billed yearly` : 'billed monthly') : null,
      h('ul', {},
        ...HIGHLIGHTS[p.id].map((t) => h('li', {}, t)),
        ...NOT_INCLUDED[p.id].map((t) => h('li', { class: 'off' }, t))),
      isCurrent
        ? h('button', { class: 'btn', disabled: true, style: { width: '100%', justifyContent: 'center' } }, 'Current plan')
        : p.id === 'site_license'
          ? h('button', { class: 'btn', style: { width: '100%', justifyContent: 'center' }, onclick: enquire }, 'Contact sales')
          : h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center' },
              onclick: () => choose(p) }, state.user ? `Switch to ${p.label}` : 'Get started'));
  }

  async function choose(p) {
    if (!state.user) return (location.hash = '#/signup');
    try {
      const r = await post('/api/v1/stripe-checkout/create-checkout-session-with-subscription',
        { plan: p.id, period });
      if (r.checkout_url) {
        // Stripe mode: the plan only moves once the webhook confirms payment.
        toast('Opening Stripe Checkout…');
        return window.location.assign(r.checkout_url);
      }
      await refresh();
      toast(`${p.label} active — ${r.note}`, 'good');
      render();
    } catch {}
  }

  function enquire() {
    const seats = h('input', { type: 'number', value: 50, min: 1 });
    const notes = h('textarea', { placeholder: 'Tell us about your deployment' });
    const m = modal({ title: 'Site License enquiry',
      body: h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Approximate users'), seats),
        h('label', { class: 'field' }, h('span', {}, 'Notes'), notes)),
      footer: [h('button', { class: 'btn primary', onclick: async () => {
        await post('/api/v2/site_license_requests', { seats: Number(seats.value), notes: notes.value });
        m.close(); toast('Enquiry recorded (see Settings → Email log)', 'good');
      } }, 'Send enquiry')] });
  }

  render().catch(() => {});
  return h('div', { class: 'layout wide' }, root);
}

export function landing(navigate) {
  return h('div', { class: 'layout wide' }, h('div', { class: 'main' },
    h('div', { class: 'hero' },
      h('h1', {}, 'Edit, sign and send documents'),
      h('p', {}, 'A browser PDF editor, form builder and e-signature workflow. '
        + 'Fill forms, redact, stamp, collect legally-ordered signatures and keep a full audit trail.'),
      h('div', { class: 'row', style: { justifyContent: 'center' } },
        h('a', { class: 'btn primary', href: '#/signup' }, 'Start free'),
        h('a', { class: 'btn', href: '#/login' }, 'Sign in'),
        h('a', { class: 'btn ghost', href: '#/pricing' }, 'See pricing'))),
    h('div', { class: 'grid', style: { maxWidth: '980px', margin: '0 auto 60px' } },
      ...[['📝', 'Full PDF editing', 'Text, images, freehand, highlight, underline, strike, whiteout and 600 stamps.'],
          ['🧾', 'Form fields', 'Nine field types with validation, signer roles, smart fields and attachments.'],
          ['✍', 'E-signature', 'Ordered envelopes, access codes, in-person signing and bulk mail merge.'],
          ['🤖', 'Document intelligence', 'Summarize, query and analyse what you are about to sign.'],
          ['🏢', 'Teams & SSO', 'Organizations, groups, SAML, verified domains and admin oversight.'],
          ['🔏', 'Audit & certification', 'Every view, fill and signature recorded with a content hash.']]
        .map(([icon, title, text]) => h('div', { class: 'card pad' },
          h('div', { style: { fontSize: '26px' } }, icon),
          h('h3', { style: { margin: '8px 0 4px' } }, title),
          h('p', { class: 'sub', style: { margin: 0 } }, text))))));
}
