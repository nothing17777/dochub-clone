import { h, clear, avatar, toast, modal } from './ui.js';
import { get, post } from './api.js';
import { state, refresh, connectCable, startGuest } from './store.js';
import { dashboard, newDocumentModal } from './views/dashboard.js';
import { editor } from './views/editor.js';
import { signView } from './views/sign.js';
import { settings } from './views/settings.js';
import { organization } from './views/org.js';
import { pricing } from './views/pricing.js';

const app = document.getElementById('app');

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || '';
  const [pathPart, queryPart] = raw.split('?');
  return {
    parts: pathPart.split('/').filter(Boolean),
    params: new URLSearchParams(queryPart || ''),
    path: pathPart,
  };
}

const navigate = (hash) => { location.hash = hash; };

async function boot() {
  const route = parseRoute();
  // The signer flow is public: never require a session for it.
  if (route.parts[0] === 'sign') return mount(route, { chrome: false });
  try { await refresh(); } catch { /* no session yet */ }
  // No accounts at all: everyone gets a guest session on arrival.
  if (!state.user) { try { await startGuest(); } catch { /* server unreachable */ } }
  if (state.user && !state.cable) connectCable(null, {});
  mount(route, { chrome: true });
}

function mount(route, { chrome }) {
  clear(app);
  const view = resolve(route);
  if (chrome) app.append(topbar(route));
  app.append(view);
}

function resolve(route) {
  const [head] = route.parts;
  if (head === 'sign') return signView(navigate, route);
  // There is no account and no marketing page: every route is the app itself.
  if (!state.user) return unreachable();
  if (head === 'd') return editor(navigate, route);
  if (head === 'pricing') return pricing(navigate);
  if (head === 'settings') return settings(navigate, route);
  if (head === 'organization') return organization(navigate, route);
  return dashboard(navigate, route);
}

/** The guest session is the only way in, so failing to get one is fatal and
 *  must say so rather than silently showing a signed-out page. */
function unreachable() {
  return h('div', { class: 'card pad', style: { margin: '48px auto', maxWidth: '420px', textAlign: 'center' } },
    h('h2', {}, 'Cannot reach the server'),
    h('p', { class: 'sub' }, 'The app could not start a session. Reload once the server is responding.'),
    h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Retry'));
}

function topbar(route) {
  const links = [['#/documents', 'Documents'], ['#/pricing', 'Pricing']];
  const unread = state.notifications.filter((n) => !n.read).length;
  return h('header', { class: 'topbar' },
    h('a', { class: 'logo', href: '#/' }, h('span', { class: 'logo-mark' }, '📄'), 'DocHub'),
    h('nav', { class: 'topnav' }, ...links.map(([href, label]) => h('a', {
      href, class: route.path.startsWith(href.slice(2)) && href !== '#/' ? 'on' : '',
    }, label))),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn ghost sm', onclick: () => newDocumentModal(navigate) }, '＋ New'),
    h('span', { class: `plan-chip ${['pro', 'site_license'].includes(state.user.plan) ? 'pro' : ''}` },
      state.entitlements.label),
    h('button', { class: 'btn ghost sm', title: 'Notifications', onclick: notifications },
      unread ? `🔔 ${unread}` : '🔔'),
    h('button', { class: 'btn ghost sm', onclick: menu, style: { padding: '2px' } }, avatar(state.user)));
}

function notifications() {
  const list = state.notifications;
  modal({ title: 'Notifications',
    body: list.length
      ? h('div', { class: 'chat' }, ...list.map((n) => h('div', { class: 'msg assistant' },
          n.body, h('div', { class: 'msg-meta' }, n.kind))))
      : h('p', { class: 'sub' }, 'Nothing new.') });
  for (const n of list.filter((x) => !x.read)) {
    post(`/api/v1/notifications/${n.id}/read`, {}).catch(() => {});
    n.read = 1;
  }
}

function menu() {
  modal({ title: 'Your workspace',
    body: h('div', { class: 'row' },
      h('a', { class: 'btn', href: '#/settings?s=profile', onclick: closeTop }, 'Settings'),
      h('a', { class: 'btn', href: '#/settings?s=usage', onclick: closeTop }, 'Usage'),
      h('a', { class: 'btn', href: '#/organization', onclick: closeTop }, 'Organization')) });
}
const closeTop = () => document.querySelector('.backdrop')?.remove();

window.addEventListener('hashchange', boot);
boot();
