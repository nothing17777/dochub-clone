import { h, clear, toast, modal, fmtDateTime, meter, avatar, add } from '../ui.js';
import { get, post, patch } from '../api.js';
import { state, refresh, can, showPaywall } from '../store.js';
import { signaturePad } from './signature.js';

const SECTIONS = [
  ['profile', 'Profile'], ['security', 'Security'], ['signatures', 'Signatures'],
  ['billing', 'Plan & billing'], ['integrations', 'Integrations'], ['fax', 'Fax'],
  ['emails', 'Email log'], ['usage', 'Usage'],
];

export function settings(navigate, route) {
  const section = route.params.get('s') || 'profile';
  const main = h('div', { class: 'main' });
  const side = h('aside', { class: 'sidebar' },
    h('div', { class: 'side-group' },
      h('div', { class: 'side-label' }, 'Settings'),
      ...SECTIONS.map(([id, label]) => h('a', {
        class: `side-item ${section === id ? 'on' : ''}`, href: `#/settings?s=${id}`,
      }, h('span', {}, label)))),
    state.organization
      ? h('a', { class: 'side-item', href: '#/organization' }, h('span', {}, '🏢'), h('span', {}, 'Organization'))
      : h('button', { class: 'side-item', onclick: createOrg }, h('span', {}, '🏢'), h('span', {}, 'Create organization')));

  async function createOrg() {
    const name = h('input', { type: 'text', value: `${state.user.name}'s team` });
    const m = modal({ title: 'Create an organization',
      body: h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      footer: [h('button', { class: 'btn primary', onclick: async () => {
        await post('/api/v1/organizations', { name: name.value });
        await refresh(); m.close(); location.hash = '#/organization';
      } }, 'Create')] });
  }

  ({ profile, security, signatures, billing, integrations, fax, emails, usage })[section]?.(main);
  return h('div', { class: 'layout' }, side, main);

  // ---------- sections ----------
  function profile(body) {
    const name = h('input', { type: 'text', value: state.user.name });
    const locale = h('select', {}, ...['en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR', 'ja-JP']
      .map((l) => h('option', { value: l, selected: state.user.locale === l }, l)));
    const color = h('input', { type: 'color', value: state.user.avatar_color });
    add(body, h('div', { class: 'page-head' }, h('h1', {}, 'Profile')),
      h('div', { class: 'card pad', style: { maxWidth: '520px' } },
        h('div', { class: 'row', style: { marginBottom: '14px' } }, avatar(state.user, 48),
          h('div', {}, h('strong', {}, state.user.email),
            h('div', { class: 'sub' }, `${state.entitlements.label} plan · joined ${fmtDateTime(state.user.created_at)}`))),
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Locale'), locale),
        h('label', { class: 'field' }, h('span', {}, 'Avatar colour'), color),
        h('button', { class: 'btn primary', onclick: async () => {
          await patch('/api/v1/users/profile', { name: name.value, locale: locale.value, avatar_color: color.value });
          await refresh(); toast('Profile saved', 'good');
        } }, 'Save profile')));
  }

  async function security(body) {
    const { login_activity } = await get('/api/v1/login-activity');
    const { sessions } = await get('/api/v1/sessions');
    const pw = h('input', { type: 'password', placeholder: 'New password' });
    const otp = h('input', { type: 'checkbox', checked: state.user.otp_enabled });
    add(clear(body), h('div', { class: 'page-head' }, h('h1', {}, 'Security')),
      h('div', { class: 'card pad', style: { maxWidth: '560px', marginBottom: '16px' } },
        h('label', { class: 'field' }, h('span', {}, 'Change password'), pw),
        h('button', { class: 'btn', onclick: async () => {
          if (pw.value.length < 8) return toast('At least 8 characters', 'bad');
          await post('/api/v1/users/otp/update-password', { password: pw.value });
          pw.value = ''; toast('Password updated', 'good');
        } }, 'Update password'),
        h('label', { class: 'check', style: { marginTop: '16px' } }, otp,
          h('span', {}, 'Require an emailed code at sign-in (two-step)')),
        h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: async () => {
          await post('/api/v1/users/otp/enable', { enabled: otp.checked });
          await refresh(); toast(otp.checked ? 'Two-step enabled' : 'Two-step disabled', 'good');
        } }, 'Save'),
        h('button', { class: 'btn danger sm', style: { marginTop: '8px', marginLeft: '8px' }, onclick: async () => {
          await post('/api/v1/users/otp/remove-other-device-sessions', {});
          toast('Other sessions revoked', 'good');
        } }, 'Sign out other devices')),
      h('div', { class: 'card' }, h('div', { style: { padding: '14px 16px 0' } }, h('strong', {}, 'Active sessions')),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Device'), h('th', {}, 'IP'), h('th', {}, 'Started'))),
          h('tbody', {}, ...sessions.map((s) => h('tr', {},
            h('td', {}, (s.user_agent || 'unknown').slice(0, 60), s.current ? h('span', { class: 'badge info', style: { marginLeft: '6px' } }, 'this device') : null),
            h('td', {}, s.ip || '—'), h('td', {}, fmtDateTime(s.created_at))))))),
      h('div', { class: 'card', style: { marginTop: '16px' } },
        h('div', { style: { padding: '14px 16px 0' } }, h('strong', {}, 'Sign-in activity')),
        h('table', {}, h('tbody', {}, ...login_activity.slice(0, 25).map((a) => h('tr', {},
          h('td', {}, a.kind), h('td', {}, a.ip || '—'), h('td', {}, fmtDateTime(a.created_at))))))));
  }

  async function signatures(body) {
    const { signatures: sigs } = await get('/api/v1/signatures');
    add(clear(body), h('div', { class: 'page-head' }, h('h1', {}, 'Signatures'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: async () => { if (await signaturePad({ kind: 'signature' })) signatures(body); } }, '＋ New signature'),
      h('button', { class: 'btn', onclick: async () => { if (await signaturePad({ kind: 'initials' })) signatures(body); } }, '＋ New initials')),
      sigs.length ? h('div', { class: 'grid' }, ...sigs.map((s) => h('div', { class: 'card pad' },
        s.png_data ? h('img', { src: s.png_data, style: { width: '100%' } }) : h('div', { html: s.svg_data }),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('span', { class: 'badge' }, s.kind), h('span', { class: 'sub' }, s.method),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn ghost sm', onclick: async () => {
            await fetch(`/api/v1/signatures/${s.id}`, { method: 'DELETE' }); signatures(body);
          } }, '🗑')))))
        : h('div', { class: 'empty card' }, h('div', { class: 'big' }, '✍'), h('p', {}, 'No saved signatures yet.')));
  }

  async function billing(body) {
    const [{ subscriptions, current }, { invoices }] = await Promise.all([
      get('/api/v1/pro-subscriptions'), get('/api/v1/stripe-invoices'),
    ]);
    const subRows = subscriptions.length
      ? subscriptions.map((s) => h('tr', {},
          h('td', {}, s.plan), h('td', {}, s.period),
          h('td', {}, h('span', { class: `badge ${s.state === 'active' ? 'good' : ''}` }, s.state)),
          h('td', {}, s.provider), h('td', {}, fmtDateTime(s.created_at))))
      : [h('tr', {}, h('td', {}, h('span', { class: 'sub' }, 'No subscription records')))];
    const invRows = invoices.length
      ? invoices.map((i) => h('tr', {},
          h('td', {}, i.number), h('td', {}, `$${(i.amount_cents / 100).toFixed(2)}`),
          h('td', {}, h('span', { class: 'badge good' }, i.state)),
          h('td', {}, fmtDateTime(i.created_at))))
      : [h('tr', {}, h('td', {}, h('span', { class: 'sub' }, 'No invoices')))];

    const header = h('div', { class: 'row' },
      h('div', {},
        h('h2', { style: { margin: 0, fontSize: '18px' } }, `${current.label} plan`),
        h('p', { class: 'sub' }, state.user.plan_renews_at
          ? `Renews ${fmtDateTime(state.user.plan_renews_at)} (${state.user.plan_period})`
          : 'No renewal date')),
      h('div', { class: 'spacer' }),
      h('a', { class: 'btn primary', href: '#/pricing' }, 'Change plan'),
      state.user.plan !== 'free'
        ? h('button', { class: 'btn danger', onclick: async () => {
            await post('/api/v1/pro-subscriptions/cancel', {});
            await refresh(); toast('Downgraded to Free'); billing(body);
          } }, 'Cancel')
        : null);

    add(clear(body), 
      h('div', { class: 'page-head' }, h('h1', {}, 'Plan & billing')),
      h('div', { class: 'card pad', style: { marginBottom: '16px' } }, header),
      card('Subscriptions', subRows),
      card('Invoices', invRows),
      h('div', { class: 'note' },
        'No payment provider is configured in this deployment. Plan changes apply immediately '
        + 'and invoices are marked test-mode; no card is charged.'));
  }

  async function integrations(body) {
    const { integrations: list } = await get('/api/v1/integrations');
    const card_ = (i) => h('div', { class: 'card pad' },
      h('div', { class: 'row' }, h('strong', {}, i.label), h('div', { class: 'spacer' }),
        h('span', { class: `badge ${i.state === 'connected' ? 'good' : i.state === 'error' ? 'bad' : ''}` }, i.state)),
      h('p', { class: 'sub', style: { margin: '8px 0' } },
        i.state === 'connected' ? `Connected as ${i.account_label || 'an unnamed account'}.`
          : i.credentials_configured ? 'Ready to connect.'
          : `OAuth credentials are not set: ${i.missing_env.join(', ')}.`),
      i.error ? h('p', { class: 'sub', style: { color: 'var(--bad, #f04438)' } }, i.error) : null,
      i.state === 'connected'
        ? h('div', { class: 'row', style: { gap: '8px' } },
          h('button', { class: 'btn sm primary', onclick: () => pickFile(i) }, 'Import a file'),
          h('button', { class: 'btn sm', onclick: async () => {
            try { await post(`/api/v1/integrations/${i.provider}/disconnect`, {}); toast('Disconnected'); integrations(body); }
            catch {}
          } }, 'Disconnect'))
        : h('button', { class: 'btn sm', disabled: !i.credentials_configured, onclick: async () => {
            try {
              const out = await post(`/api/v1/integrations/${i.provider}/connect`, {});
              // Hand the browser to the provider; it returns to the callback route.
              window.location.assign(out.authorize_url);
            } catch {}
          } }, i.credentials_configured ? 'Connect' : 'Unavailable'));


    /** Live file picker: lists the provider's own files and imports one. */
    async function pickFile(i) {
      const list = h('div', { class: 'sub' }, 'Loading…');
      const m = modal({ title: `Import from ${i.label}`, body: list,
                        footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Close')] });
      let files;
      try { ({ files } = await get(`/api/v1/integrations/${i.provider}/files`)); }
      catch { return; }
      clear(list);
      if (!files.length) return add(list, h('p', { class: 'sub' }, 'No files came back from this account.'));
      add(list, ...files.map((f) => h('div', { class: 'row', style: { padding: '6px 0' } },
        h('div', {}, h('div', {}, f.name),
          h('div', { class: 'sub', style: { fontSize: '11px' } }, f.mime || f.context || '')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: async () => {
          try {
            const out = await post(`/api/v1/integrations/${i.provider}/import`,
              { file_id: f.id, filename: f.name, mime: f.mime });
            m.close();
            toast(`Imported ${out.source.filename}`, 'good');
          } catch {}
        } }, 'Import'))));
    }

    add(clear(body), h('div', { class: 'page-head' }, h('h1', {}, 'Integrations'),
      h('p', { class: 'sub' }, 'Cloud storage and mail connections, over OAuth 2.0.')),
      h('div', { class: 'grid' }, ...list.map(card_)),
      h('div', { class: 'note' },
        'Connecting opens the provider\u2019s own consent screen. Once connected, "Import a file" lists '
        + 'that account\u2019s files and copies the one you pick in. Import from a URL works without any integration.'));
  }

  async function fax(body) {
    const [{ fax_number_provisions }, { outbound_faxes }, { area_codes }] = await Promise.all([
      get('/api/v1/fax-number-provisions'), get('/api/v1/outbound-faxes'),
      get('/api/v1/fax-number-provisions/available-fax-area-codes'),
    ]);
    const area = h('select', {}, ...area_codes.map((a) => h('option', { value: a }, a)));
    const numberRows = fax_number_provisions.map((p) => h('tr', {},
      h('td', {}, h('strong', {}, p.fax_number)),
      h('td', {}, p.area_code),
      h('td', {}, h('span', { class: 'badge good' }, p.state))));
    const faxRows = outbound_faxes.length
      ? outbound_faxes.map((f) => h('tr', {},
          h('td', {}, f.to_number), h('td', {}, `${f.pages}p`),
          h('td', {}, h('span', {
            class: `badge ${f.state === 'delivered' ? 'good' : f.state === 'failed' ? 'bad' : 'warn'}`,
          }, f.state)),
          h('td', { class: 'sub' }, f.error || ''),
          h('td', {}, fmtDateTime(f.created_at))))
      : [h('tr', {}, h('td', {}, h('span', { class: 'sub' }, 'No faxes sent')))];

    add(clear(body), 
      h('div', { class: 'page-head' }, h('h1', {}, 'Fax')),
      can('fax') ? null : h('div', { class: 'note' }, 'Faxing is a Pro feature (35 free pages a month).'),
      h('div', { class: 'card pad', style: { marginBottom: '16px', maxWidth: '420px' } },
        h('label', { class: 'field' }, h('span', {}, 'Provision a fax number'), area),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            await post('/api/v1/fax-number-provisions', { area_code: area.value });
            toast('Number provisioned', 'good'); fax(body);
          } catch { /* paywall or validation already surfaced */ }
        } }, 'Provision')),
      numberRows.length ? card('Your fax numbers', numberRows) : null,
      card('Outbound faxes', faxRows),
      h('div', { class: 'note' },
        'No fax carrier is configured, so sends are recorded and marked failed with '
        + 'no_carrier_configured. Set DOCHUB_FAX_PROVIDER_URL to wire one up.'),
      meter('Fax pages this month', state.usage.fax_pages));
  }

  async function emails(body) {
    const { email_records, delivery } = await get('/api/v1/email-records');
    const badgeFor = (st) => st === 'sent' ? 'good' : st === 'failed' ? 'bad'
      : st === 'recorded_locally' ? '' : 'warn';
    const rows = email_records.length
      ? email_records.map((e) => h('tr', {},
          h('td', {}, e.to_email),
          h('td', {},
            h('div', {}, e.subject),
            h('div', { class: 'sub', style: { fontSize: '11px' } }, linkify(e.body))),
          h('td', {}, h('span', { class: 'badge' }, e.kind)),
          h('td', {},
            h('span', { class: `badge ${badgeFor(e.state)}` }, e.state),
            e.error ? h('div', { class: 'sub', style: { fontSize: '11px' } }, e.error) : null),
          h('td', {}, fmtDateTime(e.created_at))))
      : [h('tr', {}, h('td', {}, h('span', { class: 'sub' }, 'No emails yet')))];

    const note = delivery?.mode === 'smtp'
      ? (delivery.configured
          ? `Delivery mode is "smtp": messages are handed to ${delivery.host}. `
            + 'The state column is the transport\u2019s own answer \u2014 "sent" means accepted, '
            + '"failed" shows the error it returned.'
          : 'Delivery mode is "smtp" but DOCHUB_SMTP_URL is missing or unparseable, '
            + 'so every send fails and the error is recorded.')
      : 'Delivery mode is "local": nothing leaves this machine. Set DOCHUB_DELIVERY=smtp and '
        + 'DOCHUB_SMTP_URL to send for real. Signing links are live \u2014 open one to try the signer flow.';

    add(clear(body),
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, 'Email log'),
          h('p', { class: 'sub' }, 'Every message this deployment sent or recorded, including signing links.'))),
      card('Recorded messages', rows),
      h('div', { class: 'note' }, note));
  }

  function usage(body) {
    const u = state.usage, l = state.entitlements.limits;
    add(clear(body), h('div', { class: 'page-head' }, h('h1', {}, 'Usage'),
      h('p', { class: 'sub' }, `${state.entitlements.label} plan allowances, this month.`)),
      h('div', { class: 'card pad', style: { maxWidth: '560px' } },
        meter('Documents completed', u.documents_completed),
        meter('Self-signatures', u.self_signatures),
        meter('Signature requests', u.sign_requests),
        meter('AI messages', u.ai_messages),
        meter('Emails today', u.emails_per_day),
        meter('Fax pages', u.fax_pages),
        meter('Folders', u.folders),
        meter('Templates', u.templates)),
      h('div', { class: 'card pad', style: { marginTop: '16px', maxWidth: '560px' } },
        h('strong', {}, 'Feature access on this plan'),
        h('table', {}, h('tbody', {}, ...Object.entries(state.entitlements.features).map(([k, v]) => h('tr', {},
          h('td', {}, k.replace(/_/g, ' ')),
          h('td', {}, v ? h('span', { class: 'badge good' }, 'included') : h('span', { class: 'badge' }, 'not included'))))))));
  }
}

function linkify(text) {
  const m = String(text).match(/https?:\/\/\S+|\/sign\/[a-f0-9]+/);
  if (!m) return String(text).slice(0, 120);
  const url = m[0];
  return h('span', {}, String(text).slice(0, m.index).slice(0, 60), ' ',
    h('a', { href: url.startsWith('http') ? `${url.replace(/^https?:\/\/[^/]+/, '')}` : url, target: '_blank' }, 'open signing link'));
}

/** Titled card wrapping a table body. */
function card(title, rows) {
  return h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { style: { padding: '14px 16px 0' } }, h('strong', {}, title)),
    h('table', {}, h('tbody', {}, ...rows)));
}
