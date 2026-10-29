// Schema mirrors the model inventory extracted from the production bundle
// (docs/EVIDENCE.md -> "Models"). Column sets are design choices; model names
// and relationships follow the observed Ember Data model list.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'data', 'blobs'), { recursive: true });

export const DATA_DIR = join(root, 'data');
export const BLOB_DIR = join(root, 'data', 'blobs');
export const db = new DatabaseSync(join(root, 'data', 'dochub.sqlite'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  password_salt TEXT,
  avatar_color TEXT NOT NULL DEFAULT '#2d7ff9',
  is_guest INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'password',
  otp_secret TEXT,
  otp_enabled INTEGER NOT NULL DEFAULT 0,
  accepted_site_policies INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_period TEXT NOT NULL DEFAULT 'monthly',
  plan_renews_at TEXT,
  organization_id TEXT,
  default_signature_id TEXT,
  locale TEXT NOT NULL DEFAULT 'en-US',
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT, ip TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, ip TEXT, user_agent TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',
  parent_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  hipaa_baa_accepted INTEGER NOT NULL DEFAULT 0,
  hipaa_baa_accepted_at TEXT,
  sso_enforced INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_roles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',   -- owner | admin | member
  state TEXT NOT NULL DEFAULT 'invited', -- invited | active | removed
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_groups (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saml_settings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idp_entity_id TEXT, idp_sso_url TEXT, idp_certificate TEXT,
  enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_settings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain_name TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#8a94a6',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_permissions (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'view',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- file | url | gapi | dropbox | onedrive | box | gmail | blank
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  blob_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',   -- draft | completed | archived | trashed
  is_template INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 1,
  page_count INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  certified_at TEXT, certificate_hash TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  source_page_index INTEGER,
  rotation INTEGER NOT NULL DEFAULT 0,
  width REAL NOT NULL DEFAULT 612, height REAL NOT NULL DEFAULT 792,
  deleted INTEGER NOT NULL DEFAULT 0,
  blank INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS page_labels (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_labels (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#2d7ff9'
);

CREATE TABLE IF NOT EXISTS document_doc_labels (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  doc_label_id TEXT NOT NULL REFERENCES doc_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, doc_label_id)
);

-- annotation.type values observed in the bundle: text, signature, initials, date,
-- checkbox, radio, dropdown, image, stamp, line, note, comment, attachment,
-- plus markup (highlight/underline/strikeout/whiteout/drawing).
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL DEFAULT 0, h REAL NOT NULL DEFAULT 0,
  rotation REAL NOT NULL DEFAULT 0,
  z INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS formfield_groups (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'radio'
);

CREATE TABLE IF NOT EXISTS formfields (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES formfield_groups(id) ON DELETE SET NULL,
  signer_role TEXT,
  type TEXT NOT NULL,     -- text|signature|initials|date|checkbox|radio|dropdown|image|attachment
  name TEXT NOT NULL,
  placeholder TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 0,
  readonly INTEGER NOT NULL DEFAULT 0,
  validation TEXT NOT NULL DEFAULT 'none', -- none|email|number|phone|zip|date|ssn|regex
  validation_pattern TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  value TEXT NOT NULL DEFAULT '',
  smart_field TEXT,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  font_size REAL NOT NULL DEFAULT 12,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'signature', -- signature | initials
  method TEXT NOT NULL DEFAULT 'draw',    -- draw | type | upload
  svg_data TEXT, png_data TEXT, font TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stamps (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general',
  svg TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS document_roles (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'collaborator', -- owner | collaborator | viewer | signer
  state TEXT NOT NULL DEFAULT 'invited',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sign_requests (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'remote',  -- remote | in_person | bulk
  ordered INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'sent',   -- sent | completed | voided | declined
  envelope_id TEXT,
  bulk_batch_id TEXT,
  reminder_days INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY,
  sign_request_id TEXT NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE,
  email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  role_name TEXT NOT NULL DEFAULT 'Signer',
  position INTEGER NOT NULL DEFAULT 0,
  access_token TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', -- pending | viewed | signed | declined
  verification TEXT NOT NULL DEFAULT 'none', -- none | sms | access_code
  verification_value TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  merge_data TEXT NOT NULL DEFAULT '{}',
  viewed_at TEXT, signed_at TEXT, declined_reason TEXT,
  ip TEXT, user_agent TEXT
);

CREATE TABLE IF NOT EXISTS document_activities (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  ip TEXT, user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_reminders (
  id TEXT PRIMARY KEY,
  sign_request_id TEXT NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE,
  every_days INTEGER NOT NULL DEFAULT 3,
  last_sent_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  annotation_id TEXT REFERENCES annotations(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, body TEXT NOT NULL,
  document_id TEXT, read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_records (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'generic',
  state TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fax_number_provisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area_code TEXT NOT NULL, fax_number TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'provisioned', created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_faxes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  to_number TEXT NOT NULL, pages INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'queued', -- queued | sending | delivered | failed
  error TEXT, created_at TEXT NOT NULL, delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS inbound_faxes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_number TEXT NOT NULL, pages INTEGER NOT NULL DEFAULT 1,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_threads (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Document assistant',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL, body TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,   -- documents_completed | self_signatures | sign_requests | ai_messages | emails | fax_pages
  amount INTEGER NOT NULL DEFAULT 1,
  period TEXT NOT NULL,   -- YYYY-MM
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paywall_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL, required_plan TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL, period TEXT NOT NULL DEFAULT 'monthly',
  state TEXT NOT NULL DEFAULT 'active',
  seats INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL DEFAULT 'internal-test',
  external_id TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd',
  state TEXT NOT NULL DEFAULT 'paid', number TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,  -- google_drive | gmail | dropbox | onedrive | box | classroom
  state TEXT NOT NULL DEFAULT 'disconnected',
  account_label TEXT, connected_at TEXT
);

CREATE TABLE IF NOT EXISTS export_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,     -- pdf | docx | audit | field_values | drive | dropbox | onedrive | gmail
  state TEXT NOT NULL DEFAULT 'queued',
  result_path TEXT, error TEXT,
  created_at TEXT NOT NULL, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_roles (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member'
);

CREATE INDEX IF NOT EXISTS idx_doc_owner ON documents(owner_id, state);
CREATE INDEX IF NOT EXISTS idx_ann_doc ON annotations(document_id);
CREATE INDEX IF NOT EXISTS idx_ff_doc ON formfields(document_id);
CREATE INDEX IF NOT EXISTS idx_pages_doc ON pages(document_id, position);
CREATE INDEX IF NOT EXISTS idx_usage ON usage_events(user_id, metric, period);
CREATE INDEX IF NOT EXISTS idx_act_doc ON document_activities(document_id);
`);

// --- additive migrations -------------------------------------------------
// Columns added after the first cut. SQLite has no "ADD COLUMN IF NOT EXISTS",
// so each one is attempted and a duplicate-column error is ignored.
function addColumn(table, column, decl) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`); }
  catch (err) { if (!/duplicate column/i.test(String(err.message))) throw err; }
}

for (const [table, column, decl] of [
  // real delivery outcome, per provider seam
  ['email_records', 'error', 'TEXT'],
  ['email_records', 'provider', 'TEXT'],
  ['email_records', 'sent_at', 'TEXT'],
  ['email_records', 'message_id', 'TEXT'],
  // OAuth tokens for the cloud integrations
  ['integrations', 'access_token', 'TEXT'],
  ['integrations', 'refresh_token', 'TEXT'],
  ['integrations', 'token_expires_at', 'TEXT'],
  ['integrations', 'scope', 'TEXT'],
  ['integrations', 'error', 'TEXT'],
  // Stripe linkage
  ['subscriptions', 'external_customer_id', 'TEXT'],
  ['invoices', 'external_id', 'TEXT'],
  ['invoices', 'hosted_url', 'TEXT'],
  ['invoices', 'provider', "TEXT NOT NULL DEFAULT 'internal-test'"],
  // SAML sign-in bookkeeping
  ['saml_settings', 'last_login_at', 'TEXT'],
  ['saml_settings', 'last_error', 'TEXT'],
  ['users', 'saml_name_id', 'TEXT'],
  ['users', 'stripe_customer_id', 'TEXT'],
  ['domain_settings', 'verified_method', 'TEXT'],
  ['domain_settings', 'verified_at', 'TEXT'],
]) addColumn(table, column, decl);

db.exec(`CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_verifier TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saml_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  relay_state TEXT,
  created_at TEXT NOT NULL
);`);

export const now = () => new Date().toISOString();
export const period = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
