import { toast, modal, h } from './ui.js';

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.payload = payload?.error || {};
  }
}

let onPaywall = null;
export const setPaywallHandler = (fn) => { onPaywall = fn; };

export async function api(path, { method = 'GET', body, quiet = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    const err = new ApiError(res.status, payload);
    if (res.status === 402 && onPaywall) onPaywall(err.payload);
    else if (!quiet) toast(err.message, 'bad');
    throw err;
  }
  return payload;
}

export const get = (p) => api(p);
export const post = (p, body, opts) => api(p, { method: 'POST', body, ...opts });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });
