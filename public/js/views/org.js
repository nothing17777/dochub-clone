import { h, clear, toast, modal, fmtDateTime, table, add } from '../ui.js';
import { get, post, patch } from '../api.js';
import { state, refresh, can, showPaywall } from '../store.js';

const TABS = [['people', 'People'], ['groups', 'Groups'], ['sso', 'SSO & domains'],
              ['rooms', 'Rooms & sub-orgs'], ['compliance', 'Compliance'], ['oversight', 'Oversight']];

export function organization(navigate, route) {
  const tab = route.params.get('t') || 'people';
  const main = h('div', { class: 'main' }, h('div', { class: 'empty' }, 'Loading…'));

  async function load() {
    const data = await get('/api/v1/organizations/current');
    if (!data.organization) {
      add(clear(main), h('div', { class: 'empty card' },
        h('div', { class: 'big' }, '🏢'), h('p', {}, 'You are not in an organization yet.'),
        h('a', { class: 'btn primary', href: '#/settings?s=profile' }, 'Go to settings')));
      return;
    }
    render(data);
  }

  function render(d) {
    clear(main);
    add(main, 
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, d.organization.name),
          h('p', { class: 'sub' }, `${d.members.length} member${d.members.length === 1 ? '' : 's'} · ${state.entitlements.label} plan`))),
      h('div', { class: 'tabs' }, ...TABS.map(([id, label]) => h('a', {
        class: `btn sm ${tab === id ? 'primary' : ''}`, href: `#/organization?t=${id}`,
      }, label))));
    const body = h('div', { style: { marginTop: '16px' } });
    add(main, body);
    ({ people, groups, sso, rooms, compliance, oversight })[tab](body, d);
  }

  function people(body, d) {
    const emails = h('input', { type: 'text', placeholder: 'teammate@example.com, other@example.com' });
    const role = h('select', {}, h('option', { value: 'member' }, 'Member'), h('option', { value: 'admin' }, 'Admin'));
    add(body, 
      h('div', { class: 'card pad', style: { marginBottom: '16px', maxWidth: '560px' } },
        h('label', { class: 'field' }, h('span', {}, 'Invite teammates'), emails),
        h('label', { class: 'field' }, h('span', {}, 'Role'), role),
        h('button', { class: 'btn primary', onclick: async () => {
          const list = emails.value.split(',').map((s) => s.trim()).filter(Boolean);
          if (!list.length) return;
          try { await post('/api/v1/organization-roles/create-with-emails', { emails: list, role: role.value });
                toast('Invitations recorded', 'good'); load(); } catch {}
        } }, 'Invite'),
        h('p', { class: 'sub', style: { marginTop: '8px' } },
          `Seats on this plan: ${state.entitlements.limits.team_members === null ? 'unlimited' : state.entitlements.limits.team_members}`)),
      h('div', { class: 'card' }, table(
        ['Member', 'Role', 'State', 'Invited', ''],
        d.members.map((m) => h('tr', {},
          h('td', {}, m.email),
          h('td', {}, h('span', { class: 'badge' }, m.role)),
          h('td', {}, h('span', { class: `badge ${m.state === 'active' ? 'good' : 'warn'}` }, m.state)),
          h('td', {}, fmtDateTime(m.created_at)),
          h('td', {}, m.role === 'owner' ? null : h('button', {
            class: 'btn ghost sm',
            onclick: async () => {
              await patch(`/api/v1/organization-roles/${m.id}`, { state: 'removed' });
              toast('Member removed'); load();
            },
          }, 'Remove')))))));
  }

  function groups(body, d) {
    const name = h('input', { type: 'text', placeholder: 'Group name' });
    add(body, h('div', { class: 'card pad', style: { maxWidth: '420px', marginBottom: '16px' } },
      h('label', { class: 'field' }, h('span', {}, 'New user group'), name),
      h('button', { class: 'btn primary', onclick: async () => {
        await post('/api/v1/user-groups', { name: name.value }); toast('Group created', 'good'); load();
      } }, 'Create group')),
      d.groups.length ? h('div', { class: 'card' }, h('table', {}, h('tbody', {},
        ...d.groups.map((g) => h('tr', {}, h('td', {}, g.name), h('td', {}, fmtDateTime(g.created_at)))))))
        : h('div', { class: 'empty card' }, 'No groups yet.'));
  }

  function sso(body, d) {
    const locked = !can('sso');
    const entity = h('input', { type: 'text', value: d.saml?.idp_entity_id || '', placeholder: 'https://idp.example.com/metadata' });
    const url = h('input', { type: 'text', value: d.saml?.idp_sso_url || '', placeholder: 'https://idp.example.com/sso' });
    const cert = h('textarea', { placeholder: '-----BEGIN CERTIFICATE-----' }, d.saml?.idp_certificate || '');
    const enabled = h('input', { type: 'checkbox', checked: !!d.saml?.enabled });
    const domain = h('input', { type: 'text', placeholder: 'example.com' });
    const enforce = h('input', { type: 'checkbox', checked: !!d.organization.sso_enforced });

    add(body, 
      locked ? h('div', { class: 'note' }, 'SSO is a Pro feature (up to 5 domains); Site License allows unlimited domains.') : null,
      h('div', { class: 'card pad', style: { maxWidth: '620px', marginBottom: '16px' } },
        h('h3', { style: { marginTop: 0 } }, 'SAML identity provider'),
        h('label', { class: 'field' }, h('span', {}, 'IdP entity ID'), entity),
        h('label', { class: 'field' }, h('span', {}, 'IdP SSO URL'), url),
        h('label', { class: 'field' }, h('span', {}, 'IdP certificate'), cert),
        h('label', { class: 'check' }, enabled, h('span', {}, 'Enabled')),
        h('label', { class: 'check', style: { marginTop: '8px' } }, enforce, h('span', {}, 'Require SSO for all members')),
        h('div', { class: 'row', style: { marginTop: '12px' } },
          h('button', { class: 'btn primary', onclick: async () => {
            try {
              const r = await post('/api/v1/saml-settings', {
                idp_entity_id: entity.value, idp_sso_url: url.value,
                idp_certificate: cert.value, enabled: enabled.checked,
              });
              await post('/api/v1/organizations/sso-enforced', { enforced: enforce.checked });
              toast('SAML configuration saved', 'good');
              body.querySelector('.sp-meta')?.replaceChildren(
                h('div', {}, `SP entity ID: ${r.sp_metadata.entity_id}`),
                h('div', {}, `ACS URL: ${r.sp_metadata.acs_url}`),
                h('div', { class: 'note' }, r.note));
            } catch {}
          } }, 'Save SAML')),
        h('div', { class: 'sp-meta sub', style: { marginTop: '12px' } })),
      h('div', { class: 'card pad', style: { maxWidth: '620px' } },
        h('h3', { style: { marginTop: 0 } }, 'Verified domains'),
        h('table', {}, h('tbody', {}, ...d.domains.map((dm) => h('tr', {},
          h('td', {}, dm.domain_name),
          h('td', {}, h('span', { class: `badge ${dm.verified ? 'good' : 'warn'}` }, dm.verified ? 'verified' : 'pending')))))),
        h('label', { class: 'field', style: { marginTop: '12px' } }, h('span', {}, 'Add a domain'), domain),
        h('button', { class: 'btn', onclick: async () => {
          try {
            const r = await post('/api/v1/domain-settings', { domain_name: domain.value });
            modal({ title: 'Verify this domain',
              body: h('div', {}, h('p', {}, 'Add this DNS record, then re-check:'),
                h('pre', { style: { background: 'var(--surface-2)', padding: '10px', borderRadius: '6px' } },
                  `${r.verification_record.type}  ${r.verification_record.name}  ${r.verification_record.value}`)) });
            load();
          } catch {}
        } }, 'Add domain')));
  }

  function rooms(body, d) {
    const name = h('input', { type: 'text', placeholder: 'Room name' });
    const emails = h('input', { type: 'text', placeholder: 'member@example.com' });
    const subName = h('input', { type: 'text', placeholder: 'Sub-organization name' });
    add(body, 
      can('rooms') ? null : h('div', { class: 'note' }, 'Digital rooms and sub-organizations are Site License features.'),
      h('div', { class: 'card pad', style: { maxWidth: '480px', marginBottom: '16px' } },
        h('h3', { style: { marginTop: 0 } }, 'New digital room'),
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Members'), emails),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            await post('/api/v1/rooms', { name: name.value,
              emails: emails.value.split(',').map((s) => s.trim()).filter(Boolean) });
            toast('Room created', 'good'); load();
          } catch {}
        } }, 'Create room')),
      d.rooms.length ? h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('table', {}, h('tbody', {}, ...d.rooms.map((r) => h('tr', {},
          h('td', {}, r.name), h('td', {}, fmtDateTime(r.created_at))))))) : null,
      h('div', { class: 'card pad', style: { maxWidth: '480px' } },
        h('h3', { style: { marginTop: 0 } }, 'Sub-organizations'),
        h('label', { class: 'field' }, h('span', {}, 'Name'), subName),
        h('button', { class: 'btn', onclick: async () => {
          try { await post('/api/v1/organizations/sub', { name: subName.value }); toast('Created', 'good'); load(); }
          catch {}
        } }, 'Create sub-organization'),
        d.sub_organizations.length
          ? h('table', {}, h('tbody', {}, ...d.sub_organizations.map((o) => h('tr', {}, h('td', {}, o.name)))))
          : h('p', { class: 'sub' }, 'None yet.')));
  }

  function compliance(body, d) {
    const accept = h('input', { type: 'checkbox', checked: !!d.organization.hipaa_baa_accepted });
    add(body, h('div', { class: 'card pad', style: { maxWidth: '620px' } },
      h('h3', { style: { marginTop: 0 } }, 'Compliance posture'),
      h('table', {}, h('tbody', {},
        h('tr', {}, h('td', {}, 'SOC 2 Type II / GDPR'),
          h('td', {}, h('span', { class: 'badge' }, 'Claimed by DocHub for the hosted service'))),
        h('tr', {}, h('td', {}, 'HIPAA BAA available'),
          h('td', {}, can('hipaa_baa') ? h('span', { class: 'badge good' }, 'Site License')
                                       : h('span', { class: 'badge' }, 'Site License only'))),
        h('tr', {}, h('td', {}, 'BAA recorded'),
          h('td', {}, d.organization.hipaa_baa_accepted
            ? h('span', { class: 'badge good' }, fmtDateTime(d.organization.hipaa_baa_accepted_at))
            : h('span', { class: 'badge' }, 'not recorded'))))),
      h('label', { class: 'check', style: { marginTop: '14px' } }, accept,
        h('span', {}, 'Record BAA acceptance for this organization')),
      h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: async () => {
        try {
          const r = await post('/api/v1/organizations/hipaa-baa', { accepted: accept.checked });
          toast('Recorded', 'good');
          add(body, h('div', { class: 'note' }, r.note));
          load();
        } catch {}
      } }, 'Save'),
      h('div', { class: 'note' },
        'This records an attestation in the database. Compliance certifications and a countersigned BAA '
        + 'are legal and operational matters that no self-hosted copy of this app can confer.')));
  }

  async function oversight(body) {
    if (!can('admin_oversight')) {
      add(body, h('div', { class: 'note' }, 'Advanced admin oversight is a Site License feature.'),
        h('a', { class: 'btn primary', href: '#/pricing' }, 'See plans'));
      return;
    }
    try {
      const [{ stats }, { login_activity }, { activities }] = await Promise.all([
        get('/api/v1/admin-stats/home-page-stats-v2'),
        get('/api/v1/organizations/login-activity'),
        get('/api/v1/organizations/document-activity'),
      ]);
      add(body, h('div', { class: 'grid' }, ...Object.entries(stats).map(([k, v]) =>
        h('div', { class: 'card pad' }, h('div', { class: 'price' }, v),
          h('div', { class: 'sub' }, k.replace(/_/g, ' '))))),
        h('div', { class: 'card', style: { marginTop: '16px' } },
          h('div', { style: { padding: '14px 16px 0' } }, h('strong', {}, 'Sign-in activity')),
          h('table', {}, h('tbody', {}, ...login_activity.slice(0, 20).map((a) => h('tr', {},
            h('td', {}, a.email), h('td', {}, a.ip || '—'), h('td', {}, fmtDateTime(a.created_at))))))),
        h('div', { class: 'card', style: { marginTop: '16px' } },
          h('div', { style: { padding: '14px 16px 0' } }, h('strong', {}, 'Document activity')),
          h('table', {}, h('tbody', {}, ...activities.slice(0, 30).map((a) => h('tr', {},
            h('td', {}, a.action), h('td', {}, a.actor_email || '—'), h('td', {}, fmtDateTime(a.created_at))))))));
    } catch {}
  }

  load().catch(() => {});
  return h('div', { class: 'layout wide' }, main);
}
