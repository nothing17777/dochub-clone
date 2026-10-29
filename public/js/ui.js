// Tiny DOM helpers. No framework: the app is small enough to hand-roll.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Append children to an existing element, skipping null/false the way h() does.
 *  Element.append would otherwise stringify them into the page. */
export function add(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function toast(message, kind = '') {
  const root = document.getElementById('toast-root');
  const t = h('div', { class: `toast ${kind}` }, message);
  root.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, kind === 'bad' ? 6000 : 3200);
  setTimeout(() => t.remove(), kind === 'bad' ? 6400 : 3600);
}

export function modal({ title, body, footer, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => { back.remove(); onClose?.(); };
  const back = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}` },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'x', onclick: close }, '×')),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null));
  root.append(back);
  const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  return { close, el: back };
}

export function confirmModal(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    const m = modal({
      title, body: h('p', {}, message),
      footer: [
        h('button', { class: 'btn ghost', onclick: () => { m.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { m.close(); resolve(true); } }, confirmLabel),
      ],
      onClose: () => resolve(false),
    });
  });
}

export const initials = (s) => String(s || '?').trim().split(/[\s@.]+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();

export const avatar = (user, size) => h('div', {
  class: 'avatar',
  style: size ? { width: `${size}px`, height: `${size}px`, background: user?.avatar_color || '#8a94a6' }
              : { background: user?.avatar_color || '#8a94a6' },
  title: user?.email || '',
}, initials(user?.name || user?.email));

export const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined,
  { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
export const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString() : '—';

export function meter(label, { used, limit }) {
  const pct = limit == null ? 0 : Math.min(100, (used / limit) * 100);
  const cls = limit == null ? '' : pct >= 100 ? 'full' : pct >= 75 ? 'near' : '';
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-top' },
      h('span', {}, label),
      h('span', { style: { color: 'var(--text-faint)' } }, limit == null ? `${used} · unlimited` : `${used} / ${limit}`)),
    h('div', { class: 'meter-bar' }, h('div', { class: `meter-fill ${cls}`, style: { width: `${pct}%` } })));
}

/** Table with optional header row. Keeps deep call nesting out of views. */
export function table(headers, rows) {
  return h('table', {},
    headers ? h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', {}, t)))) : null,
    h('tbody', {}, ...rows));
}
