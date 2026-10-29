import { h, clear, avatar, toast, modal } from './ui.js';
import { get, post } from './api.js';
import { state, refresh, connectCable, startGuest } from './store.js';
import { signIn } from './views/auth.js';
import { dashboard, newDocumentModal } from './views/dashboard.js';
import { editor } from './views/editor.js';
import { signView } from './views/sign.js';
import { settings } from './views/settings.js';
import { organization } from './views/org.js';
import { pricing, landing } from './views/pricing.js';

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
  try { await refresh(); } catch { /* unauthenticated */ }
  // No account required: fall back to a guest session rather than a sign-in wall.
  if (!state.user) { try { await startGuest(); } catch { /* offline */ } }
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
  if (head === 'd') return state.user ? editor(navigate, route) : signIn(navigate);
  // A guest can still claim a real account.
  if (head === 'login' || head === 'signup') return signIn(navigate);
  if (head === 'pricing') return pricing(navigate);
  if (!state.user) {
    if (head === 'login' || head === 'signup') return signIn(navigate);
    return landing(navigate);
  }
  if (head === 'settings') return settings(navigate, route);
  if (head === 'organization') return organization(navigate, route);
  if (head === 'documents' || !head) return dashboard(navigate, route);
  return dashboard(navigate, route);
}

function topbar(route) {
  const links = state.user
    ? [['#/documents', 'Documents'], ['#/pricing', 'Pricing']]
    : [['#/pricing', 'Pricing']];
  const unread = state.notifications.filter((n) => !n.read).length;
  return h('header', { class: 'topbar' },
    h('a', { class: 'logo', href: '#/' }, h('span', { class: 'logo-mark' }, '📄'), 'DocHub'),
    h('nav', { class: 'topnav' }, ...links.map(([href, label]) => h('a', {
      href, class: route.path.startsWith(href.slice(2)) && href !== '#/' ? 'on' : '',
    }, label))),
    h('div', { class: 'spacer' }),
    state.user ? h('button', { class: 'btn ghost sm', onclick: () => newDocumentModal(navigate) }, '＋ New') : null,
    state.user ? h('span', { class: `plan-chip ${['pro', 'site_license'].includes(state.user.plan) ? 'pro' : ''}` },
      state.entitlements.label) : null,
    state.user ? h('button', { class: 'btn ghost sm', title: 'Notifications', onclick: notifications },
      unread ? `🔔 ${unread}` : '🔔') : null,
    state.user
      ? h('button', { class: 'btn ghost sm', onclick: menu, style: { padding: '2px' } }, avatar(state.user))
      : h('div', { class: 'row' },
          h('a', { class: 'btn ghost sm', href: '#/login' }, 'Sign in'),
          h('a', { class: 'btn primary sm', href: '#/signup' }, 'Start free')));
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
  modal({ title: state.user.is_guest ? 'Guest session' : state.user.email,
    body: h('div', { class: 'row' },
      state.user.is_guest
        ? h('a', { class: 'btn primary', href: '#/signup', onclick: closeTop }, 'Save your work')
        : null,
      h('a', { class: 'btn', href: '#/settings?s=profile', onclick: closeTop }, 'Settings'),
      h('a', { class: 'btn', href: '#/settings?s=usage', onclick: closeTop }, 'Usage'),
      h('a', { class: 'btn', href: '#/organization', onclick: closeTop }, 'Organization'),
      h('button', { class: 'btn danger', onclick: async () => {
        await post('/api/v1/users/sign-out', {});
        location.hash = '#/'; location.reload();
      } }, 'Sign out')) });
}
const closeTop = () => document.querySelector('.backdrop')?.remove();

window.addEventListener('hashchange', boot);
boot();
