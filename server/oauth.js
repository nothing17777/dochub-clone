// OAuth 2.0 authorization-code flow and file import for the cloud providers.
// A provider only appears as connectable when its client id *and* secret are
// present; everything else about it is reported as unconfigured, not faked.
import { randomBytes } from 'node:crypto';
import { db, now } from './db.js';

const env = (k) => process.env[k] || null;

export const PROVIDERS = {
  google_drive: {
    label: 'Google Drive', family: 'google',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  },
  gmail: {
    label: 'Gmail', family: 'google',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  classroom: {
    label: 'Google Classroom', family: 'google',
    scopes: ['https://www.googleapis.com/auth/classroom.courses.readonly',
             'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
             'https://www.googleapis.com/auth/drive.readonly'],
  },
  dropbox: { label: 'Dropbox', family: 'dropbox', scopes: ['files.content.read', 'account_info.read'] },
  onedrive: { label: 'OneDrive', family: 'microsoft', scopes: ['offline_access', 'Files.Read', 'User.Read'] },
  box: { label: 'Box', family: 'box', scopes: ['root_readonly'] },
};

const FAMILY = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    id: 'DOCHUB_GOOGLE_CLIENT_ID', secret: 'DOCHUB_GOOGLE_CLIENT_SECRET',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
  dropbox: {
    authorize: 'https://www.dropbox.com/oauth2/authorize',
    token: 'https://api.dropboxapi.com/oauth2/token',
    id: 'DOCHUB_DROPBOX_APP_KEY', secret: 'DOCHUB_DROPBOX_APP_SECRET',
    extra: { token_access_type: 'offline' },
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    id: 'DOCHUB_MS_CLIENT_ID', secret: 'DOCHUB_MS_CLIENT_SECRET', extra: {},
  },
  box: {
    authorize: 'https://account.box.com/api/oauth2/authorize',
    token: 'https://api.box.com/oauth2/token',
    id: 'DOCHUB_BOX_CLIENT_ID', secret: 'DOCHUB_BOX_CLIENT_SECRET', extra: {},
  },
};

export const familyOf = (provider) => FAMILY[PROVIDERS[provider]?.family] || null;

export function credentials(provider) {
  const f = familyOf(provider);
  if (!f) return { configured: false };
  const id = env(f.id), secret = env(f.secret);
  return { configured: !!(id && secret), client_id: id, client_secret: secret,
           id_var: f.id, secret_var: f.secret };
}

export const redirectUri = (base) =>
  process.env.DOCHUB_OAUTH_REDIRECT_URI || `${base}/api/v1/integrations/callback`;

export function authorizeUrl(provider, user, base) {
  const f = familyOf(provider);
  const c = credentials(provider);
  const state = randomBytes(24).toString('hex');
  const uri = redirectUri(base);
  db.prepare('INSERT INTO oauth_states (state,user_id,provider,redirect_uri,created_at) VALUES (?,?,?,?,?)')
    .run(state, user.id, provider, uri, now());
  const url = new URL(f.authorize);
  url.searchParams.set('client_id', c.client_id);
  url.searchParams.set('redirect_uri', uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', PROVIDERS[provider].scopes.join(' '));
  for (const [k, v] of Object.entries(f.extra)) url.searchParams.set(k, v);
  return { url: url.toString(), state, redirect_uri: uri };
}

async function tokenCall(provider, params) {
  const f = familyOf(provider);
  const c = credentials(provider);
  const res = await fetch(f.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, ...params }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported verbatim below */ }
  if (!res.ok) throw new Error(`${PROVIDERS[provider].label} token endpoint returned ${res.status}: ${text.slice(0, 300)}`);
  if (!json?.access_token) throw new Error(`${PROVIDERS[provider].label} returned no access_token: ${text.slice(0, 300)}`);
  return json;
}

export const exchangeCode = (provider, code, uri) =>
  tokenCall(provider, { grant_type: 'authorization_code', code, redirect_uri: uri });

export const refresh = (provider, refreshToken) =>
  tokenCall(provider, { grant_type: 'refresh_token', refresh_token: refreshToken });

export function storeTokens(userId, provider, tokens, accountLabel) {
  const existing = db.prepare('SELECT * FROM integrations WHERE user_id=? AND provider=?').get(userId, provider);
  const expires = tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null;
  if (existing) {
    db.prepare(`UPDATE integrations SET state='connected', access_token=?, refresh_token=COALESCE(?,refresh_token),
                token_expires_at=?, scope=?, account_label=COALESCE(?,account_label), connected_at=?, error=NULL
                WHERE id=?`)
      .run(tokens.access_token, tokens.refresh_token ?? null, expires, tokens.scope ?? null,
           accountLabel ?? null, now(), existing.id);
    return db.prepare('SELECT * FROM integrations WHERE id=?').get(existing.id);
  }
  const id = randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO integrations (id,user_id,provider,state,account_label,connected_at,
              access_token,refresh_token,token_expires_at,scope)
              VALUES (?,?,?,'connected',?,?,?,?,?,?)`)
    .run(id, userId, provider, accountLabel ?? null, now(),
         tokens.access_token, tokens.refresh_token ?? null, expires, tokens.scope ?? null);
  return db.prepare('SELECT * FROM integrations WHERE id=?').get(id);
}

/** A live access token, refreshed if it has expired and we hold a refresh token. */
export async function accessToken(row) {
  const fresh = !row.token_expires_at || Date.parse(row.token_expires_at) - 60_000 > Date.now();
  if (fresh && row.access_token) return row.access_token;
  if (!row.refresh_token) {
    throw new Error(`the ${PROVIDERS[row.provider].label} token has expired and no refresh token was issued; reconnect`);
  }
  const tokens = await refresh(row.provider, row.refresh_token);
  return storeTokens(row.user_id, row.provider, tokens, row.account_label).access_token;
}

// --- provider APIs --------------------------------------------------------
async function api(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}
const asJson = async (...a) => (await api(...a)).json();

/** Who the tokens belong to -- shown as the integration's account label. */
export async function accountLabel(provider, token) {
  try {
    switch (PROVIDERS[provider].family) {
      case 'google': {
        const me = await asJson('https://www.googleapis.com/oauth2/v3/userinfo', token);
        return me.email || me.name || null;
      }
      case 'dropbox': {
        const res = await api('https://api.dropboxapi.com/2/users/get_current_account', token, { method: 'POST' });
        const me = await res.json();
        return me.email || me.name?.display_name || null;
      }
      case 'microsoft': {
        const me = await asJson('https://graph.microsoft.com/v1.0/me', token);
        return me.mail || me.userPrincipalName || null;
      }
      case 'box': {
        const me = await asJson('https://api.box.com/2.0/users/me', token);
        return me.login || me.name || null;
      }
      default: return null;
    }
  } catch { return null; }
}

const GOOGLE_EXPORTS = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.drawing': 'application/pdf',
};

/** Picker listing: [{ id, name, mime, size }]. */
export async function listFiles(provider, token, { query = '', limit = 50 } = {}) {
  switch (provider) {
    case 'google_drive':
    case 'classroom': {
      const q = ["trashed = false", "mimeType != 'application/vnd.google-apps.folder'"];
      if (query) q.push(`name contains '${query.replace(/'/g, "\\'")}'`);
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', q.join(' and '));
      url.searchParams.set('pageSize', String(limit));
      url.searchParams.set('fields', 'files(id,name,mimeType,size,modifiedTime)');
      const out = await asJson(url, token);
      return (out.files || []).map((f) => ({ id: f.id, name: f.name, mime: f.mimeType,
                                             size: Number(f.size) || null, modified_at: f.modifiedTime }));
    }
    case 'gmail': {
      const list = await asJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}`
        + `&q=${encodeURIComponent(`has:attachment ${query}`.trim())}`, token);
      const files = [];
      for (const m of (list.messages || []).slice(0, limit)) {
        const msg = await asJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, token);
        const subject = msg.payload?.headers?.find((h) => h.name.toLowerCase() === 'subject')?.value || '(no subject)';
        for (const part of flattenParts(msg.payload)) {
          if (!part.filename || !part.body?.attachmentId) continue;
          files.push({ id: `${m.id}:${part.body.attachmentId}`, name: part.filename,
                       mime: part.mimeType, size: part.body.size || null, context: subject });
        }
      }
      return files;
    }
    case 'dropbox': {
      const body = query
        ? { query, options: { max_results: limit, file_status: 'active' } }
        : { path: '', recursive: false, limit };
      const url = query ? 'https://api.dropboxapi.com/2/files/search_v2' : 'https://api.dropboxapi.com/2/files/list_folder';
      const out = await asJson(url, token, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const entries = query ? (out.matches || []).map((m) => m.metadata?.metadata) : out.entries;
      return (entries || []).filter((e) => e && e['.tag'] === 'file')
        .map((e) => ({ id: e.path_lower || e.id, name: e.name, mime: null, size: e.size ?? null }));
    }
    case 'onedrive': {
      const url = query
        ? `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(query)}')`
        : 'https://graph.microsoft.com/v1.0/me/drive/root/children';
      const out = await asJson(`${url}?$top=${limit}`, token);
      return (out.value || []).filter((f) => f.file)
        .map((f) => ({ id: f.id, name: f.name, mime: f.file?.mimeType || null, size: f.size ?? null }));
    }
    case 'box': {
      const url = query
        ? `https://api.box.com/2.0/search?type=file&limit=${limit}&query=${encodeURIComponent(query)}`
        : `https://api.box.com/2.0/folders/0/items?limit=${limit}&fields=id,name,size,type`;
      const out = await asJson(url, token);
      return (out.entries || []).filter((e) => e.type === 'file')
        .map((e) => ({ id: e.id, name: e.name, mime: null, size: e.size ?? null }));
    }
    default: throw new Error(`listing is not implemented for ${provider}`);
  }
}

function* flattenParts(part) {
  if (!part) return;
  yield part;
  for (const p of part.parts || []) yield* flattenParts(p);
}

/** Download one file: { buffer, filename, mime }. */
export async function downloadFile(provider, token, fileId, hint = {}) {
  switch (provider) {
    case 'google_drive':
    case 'classroom': {
      const meta = await asJson(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`, token);
      const exportAs = GOOGLE_EXPORTS[meta.mimeType];
      const url = exportAs
        ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportAs)}`
        : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
      const res = await api(url, token);
      return { buffer: Buffer.from(await res.arrayBuffer()),
               filename: exportAs ? `${meta.name}.pdf` : meta.name,
               mime: exportAs || meta.mimeType };
    }
    case 'gmail': {
      const [messageId, attachmentId] = String(fileId).split(':');
      if (!attachmentId) throw new Error('a Gmail file id is "<messageId>:<attachmentId>"');
      const out = await asJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`, token);
      return { buffer: Buffer.from(String(out.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
               filename: hint.filename || 'attachment.pdf', mime: hint.mime || 'application/pdf' };
    }
    case 'dropbox': {
      const res = await api('https://content.dropboxapi.com/2/files/download', token, {
        method: 'POST', headers: { 'Dropbox-API-Arg': JSON.stringify({ path: fileId }) },
      });
      const meta = JSON.parse(res.headers.get('dropbox-api-result') || '{}');
      return { buffer: Buffer.from(await res.arrayBuffer()),
               filename: meta.name || hint.filename || 'download',
               mime: res.headers.get('content-type') || 'application/octet-stream' };
    }
    case 'onedrive': {
      const meta = await asJson(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}`, token);
      const res = await api(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}/content`, token);
      return { buffer: Buffer.from(await res.arrayBuffer()), filename: meta.name,
               mime: meta.file?.mimeType || 'application/octet-stream' };
    }
    case 'box': {
      const meta = await asJson(`https://api.box.com/2.0/files/${encodeURIComponent(fileId)}`, token);
      const res = await api(`https://api.box.com/2.0/files/${encodeURIComponent(fileId)}/content`, token);
      return { buffer: Buffer.from(await res.arrayBuffer()), filename: meta.name,
               mime: res.headers.get('content-type') || 'application/octet-stream' };
    }
    default: throw new Error(`import is not implemented for ${provider}`);
  }
}
