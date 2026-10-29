import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, now, BLOB_DIR } from '../db.js';
import { badRequest, notFound, forbidden } from '../http.js';
import { requireFeature } from '../entitlements.js';
import {
  PROVIDERS, credentials, authorizeUrl, exchangeCode, storeTokens,
  accessToken, accountLabel, listFiles, downloadFile, redirectUri,
} from '../oauth.js';
import { baseUrl } from '../saml.js';

const SOURCE_KIND = { google_drive: 'gapi', classroom: 'gapi', gmail: 'gmail',
                      dropbox: 'dropbox', onedrive: 'onedrive', box: 'box' };

function connected(user, provider) {
  if (!PROVIDERS[provider]) throw notFound('Unknown provider');
  const row = db.prepare("SELECT * FROM integrations WHERE user_id=? AND provider=? AND state='connected'")
    .get(user.id, provider);
  if (!row) throw badRequest(`${PROVIDERS[provider].label} is not connected: run the connect flow first`);
  return row;
}

export default function mount(r) {
  /** Start the authorization-code flow. Returns the URL to send the browser to. */
  r.post('/api/v1/integrations/:provider/connect', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'cloud_integrations');
    const { provider } = ctx.params;
    if (!PROVIDERS[provider]) throw notFound('Unknown provider');
    const c = credentials(provider);
    if (!c.configured) {
      throw badRequest(`${PROVIDERS[provider].label} needs OAuth credentials: `
        + `set ${c.id_var} and ${c.secret_var} before connecting`);
    }
    const { url, state, redirect_uri } = authorizeUrl(provider, u, baseUrl(ctx));
    return { provider, authorize_url: url, state, redirect_uri,
             scopes: PROVIDERS[provider].scopes,
             note: 'Open authorize_url, grant access, and the provider posts back to redirect_uri.' };
  });

  /** OAuth redirect target. Exchanges the code and stores the tokens. */
  r.get('/api/v1/integrations/callback', async (ctx) => {
    const { code, state, error, error_description } = ctx.query;
    const row = state ? db.prepare('SELECT * FROM oauth_states WHERE state=?').get(state) : null;
    if (!row) throw badRequest('Unknown or expired OAuth state');
    db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
    if (error) {
      db.prepare("UPDATE integrations SET state='error', error=? WHERE user_id=? AND provider=?")
        .run(`${error}: ${error_description || ''}`.trim(), row.user_id, row.provider);
      throw badRequest(`${PROVIDERS[row.provider].label} refused authorization: ${error_description || error}`);
    }
    if (!code) throw badRequest('No authorization code in the callback');

    let tokens;
    try { tokens = await exchangeCode(row.provider, code, row.redirect_uri); }
    catch (err) {
      db.prepare(`INSERT OR IGNORE INTO integrations (id,user_id,provider,state) VALUES (?,?,?,'error')`)
        .run(randomUUID(), row.user_id, row.provider);
      db.prepare("UPDATE integrations SET state='error', error=? WHERE user_id=? AND provider=?")
        .run(String(err.message), row.user_id, row.provider);
      throw badRequest(`Token exchange failed: ${err.message}`);
    }
    const label = await accountLabel(row.provider, tokens.access_token);
    const integration = storeTokens(row.user_id, row.provider, tokens, label);

    if ((ctx.req.headers.accept || '').includes('application/json')) {
      return { connected: true, integration: redact(integration) };
    }
    ctx.redirect('/settings/integrations');
    return null;
  });

  r.post('/api/v1/integrations/:provider/disconnect', async (ctx) => {
    const u = ctx.requireUser();
    const row = db.prepare('SELECT * FROM integrations WHERE user_id=? AND provider=?').get(u.id, ctx.params.provider);
    if (!row) throw notFound('Not connected');
    db.prepare(`UPDATE integrations SET state='disconnected', access_token=NULL, refresh_token=NULL,
                token_expires_at=NULL WHERE id=?`).run(row.id);
    return { disconnected: true, note: 'Tokens were discarded here; revoke the grant with the provider too.' };
  });

  /** File picker. Talks to the provider, so it fails loudly if the grant lapsed. */
  r.get('/api/v1/integrations/:provider/files', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'cloud_integrations');
    const row = connected(u, ctx.params.provider);
    try {
      const token = await accessToken(row);
      const files = await listFiles(ctx.params.provider, token,
        { query: String(ctx.query.q || ''), limit: Math.min(100, Number(ctx.query.limit) || 50) });
      return { provider: ctx.params.provider, account: row.account_label, files };
    } catch (err) {
      db.prepare('UPDATE integrations SET error=? WHERE id=?').run(String(err.message), row.id);
      throw badRequest(`${PROVIDERS[ctx.params.provider].label} listing failed: ${err.message}`);
    }
  });

  /** Import one picked file: downloads the bytes and creates a sources row. */
  r.post('/api/v1/integrations/:provider/import', async (ctx) => {
    const u = ctx.requireUser();
    requireFeature(u, 'cloud_integrations');
    const { provider } = ctx.params;
    const row = connected(u, provider);
    const fileId = String(ctx.body.file_id || '');
    if (!fileId) throw badRequest('file_id is required');

    const taskId = randomUUID();
    db.prepare(`INSERT INTO export_tasks (id,user_id,document_id,kind,state,created_at)
                VALUES (?,?,NULL,?,'queued',?)`).run(taskId, u.id, `import_${provider}`, now());
    try {
      const token = await accessToken(row);
      const file = await downloadFile(provider, token, fileId,
        { filename: ctx.body.filename, mime: ctx.body.mime });
      if (!file.buffer.length) throw new Error('the provider returned an empty file');
      const sha = createHash('sha256').update(file.buffer).digest('hex');
      writeFileSync(join(BLOB_DIR, `${sha}.bin`), file.buffer);
      const id = randomUUID();
      db.prepare(`INSERT INTO sources (id,owner_id,kind,filename,mime,byte_size,sha256,blob_path,created_at)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, u.id, SOURCE_KIND[provider], file.filename, file.mime || 'application/octet-stream',
             file.buffer.length, sha, `${sha}.bin`, now());
      db.prepare("UPDATE export_tasks SET state='succeeded', finished_at=? WHERE id=?").run(now(), taskId);
      return { task_id: taskId, source: db.prepare('SELECT * FROM sources WHERE id=?').get(id),
               provider, account: row.account_label };
    } catch (err) {
      db.prepare("UPDATE export_tasks SET state='failed', error=?, finished_at=? WHERE id=?")
        .run(String(err.message), now(), taskId);
      db.prepare('UPDATE integrations SET error=? WHERE id=?').run(String(err.message), row.id);
      throw badRequest(`Import from ${PROVIDERS[provider].label} failed: ${err.message}`);
    }
  });
}

const redact = (row) => row && ({ ...row, access_token: undefined, refresh_token: undefined });
