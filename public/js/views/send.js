import { h, modal, toast, clear, add } from '../ui.js';
import { post } from '../api.js';
import { can, showPaywall, state } from '../store.js';

/** Compose a signature request: remote, ordered, in-person or bulk mail-merge. */
export function sendForSignatureModal(ed, reload) {
  let mode = 'remote';
  const subject = h('input', { type: 'text', value: `Please sign: ${ed.doc.title}` });
  const message = h('textarea', { placeholder: 'Add a note for your signers…' });
  const ordered = h('input', { type: 'checkbox' });
  const rows = h('div', {});
  const bulkCsv = h('textarea', { placeholder: 'email,name\na@example.com,Ada\nb@example.com,Blaise',
                                  style: { minHeight: '120px', fontFamily: 'monospace' } });
  const result = h('div', {});

  const signerRow = (i) => {
    const email = h('input', { type: 'email', placeholder: 'signer@example.com' });
    const name = h('input', { type: 'text', placeholder: 'Name (optional)' });
    const role = h('input', { type: 'text', value: `Signer ${i + 1}` });
    const verify = h('select', {}, h('option', { value: 'none' }, 'No verification'),
      h('option', { value: 'access_code' }, 'Access code'));
    const code = h('input', { type: 'text', placeholder: 'Access code' });
    const row = h('div', { class: 'card pad', style: { marginBottom: '10px' } },
      h('div', { class: 'row' }, h('div', { style: { flex: '1 1 180px' } }, email),
        h('div', { style: { flex: '1 1 120px' } }, name)),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('div', { style: { flex: '1 1 110px' } }, role),
        h('div', { style: { flex: '1 1 130px' } }, verify),
        h('div', { style: { flex: '1 1 110px' } }, code),
        h('button', { class: 'btn ghost sm', onclick: () => row.remove() }, '×')));
    row._read = () => email.value.trim() ? {
      email: email.value.trim(), name: name.value.trim(), role_name: role.value.trim(),
      verification: verify.value, verification_value: verify.value === 'none' ? null : code.value,
    } : null;
    return row;
  };
  rows.append(signerRow(0));

  const body = h('div', {});
  const render = () => {
    clear(body);
    add(body, 
      h('div', { class: 'tabs' },
        h('button', { class: mode === 'remote' ? 'on' : '', onclick: () => { mode = 'remote'; render(); } }, 'Email signers'),
        h('button', { class: mode === 'in_person' ? 'on' : '', onclick: () => {
          if (!can('in_person_signing')) return showPaywall({ message: 'In-person signing is a Pro feature', feature: 'in_person_signing', required_plan: 'pro' });
          mode = 'in_person'; render();
        } }, can('in_person_signing') ? 'In person' : 'In person 🔒'),
        h('button', { class: mode === 'bulk' ? 'on' : '', onclick: () => {
          if (!can('bulk_send')) return showPaywall({ message: 'Bulk send is a Pro feature', feature: 'bulk_send', required_plan: 'pro' });
          mode = 'bulk'; render();
        } }, can('bulk_send') ? 'Bulk send' : 'Bulk send 🔒')));

    if (!ed.formfields.length) {
      add(body, h('div', { class: 'note' },
        'This document has no form fields. Signers will be able to sign, but will have nothing to fill in. '
        + 'Add fields with the Fields tool first if you need data back.'));
    }

    add(body, h('label', { class: 'field' }, h('span', {}, 'Subject'), subject),
      h('label', { class: 'field' }, h('span', {}, 'Message'), message));

    if (mode === 'bulk') {
      add(body, h('label', { class: 'field' },
        h('span', {}, 'Recipients', h('span', { class: 'hint' }, ' — CSV; the header names become merge fields')), bulkCsv),
        h('p', { class: 'sub' }, 'Each row gets its own envelope. Column values populate matching smart fields.'));
    } else {
      add(body, h('h3', { style: { fontSize: '13px', textTransform: 'uppercase', color: 'var(--text-faint)' } }, 'Signers'),
        rows,
        h('button', { class: 'btn sm', onclick: () => rows.append(signerRow(rows.children.length)) }, '＋ Add signer'),
        h('label', { class: 'check', style: { marginTop: '12px' } }, ordered,
          h('span', {}, 'Sign in order (each signer is notified after the previous one signs)')));
    }
    add(body, result,
      h('div', { class: 'note' }, `Signature requests this month: ${state.usage.sign_requests.used}`
        + (state.usage.sign_requests.limit == null ? ' (unlimited)' : ` of ${state.usage.sign_requests.limit}`)
        + '. Emails are recorded locally, not delivered — open the signing links from the result below or Settings → Email log.'));
  };

  const send = async () => {
    try {
      if (mode === 'bulk') {
        const lines = bulkCsv.value.trim().split('\n').filter(Boolean);
        if (lines.length < 2) return toast('Add a header row and at least one recipient', 'bad');
        const cols = lines[0].split(',').map((s) => s.trim());
        const recipients = lines.slice(1).map((l) => {
          const vals = l.split(',').map((s) => s.trim());
          return Object.fromEntries(cols.map((c, i) => [c, vals[i] ?? '']));
        });
        const r = await post('/api/v1/sign-requests/bulk-send',
          { document_id: ed.doc.id, subject: subject.value, message: message.value, recipients });
        clear(result).append(h('div', { class: 'card pad' },
          h('strong', {}, `Batch ${r.batch_id}`), h('p', { class: 'sub' }, `${r.sent} envelopes created.`)));
        toast(`${r.sent} envelopes sent`, 'good');
      } else {
        const signers = [...rows.children].map((r) => r._read?.()).filter(Boolean);
        if (!signers.length) return toast('Add at least one signer', 'bad');
        const path = mode === 'in_person'
          ? '/api/v1/sign-requests/in-person' : '/api/v1/sign-requests/create-with-document-roles';
        const r = await post(path, { document_id: ed.doc.id, subject: subject.value,
                                     message: message.value, ordered: ordered.checked, signers });
        clear(result).append(h('div', { class: 'card pad' },
          h('strong', {}, 'Signing links'),
          ...(r.signing_urls || r.signers.map((s) => ({ email: s.email, url: null }))).map((s) => h('div', {},
            s.url ? h('a', { href: s.url, target: '_blank' }, `${s.email} → open signing page`)
                  : h('span', {}, `${s.email} — link recorded in the email log`)))));
        toast(mode === 'in_person' ? 'Ready to sign on this device' : 'Signature request sent', 'good');
      }
      await reload();
    } catch {}
  };

  const m = modal({ title: 'Send for signature', wide: true, body,
    footer: [h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Close'),
             h('button', { class: 'btn primary', onclick: send }, 'Send')] });
  render();
  return m;
}
