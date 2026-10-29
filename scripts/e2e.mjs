// End-to-end API exercise against a running server. Verifies the entitlement
// engine, editor persistence, the signer flow and the audit trail.
const BASE = process.env.BASE || 'http://localhost:4173';
let pass = 0, fail = 0;
const jar = new Map();

const ck = (name) => jar.get(name) || '';
function store(res, name) {
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const [kv] = c.split(';');
    const [k, v] = kv.split('=');
    if (k === 'dh_session') jar.set(name, v);
  }
}
async function call(name, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(ck(name) ? { cookie: `dh_session=${ck(name)}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  store(res, name);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

const skip = (label, why) => console.log(`  skip ${label} (${why})`);

/** Sign and post a Stripe event, for deployments running in Stripe mode. */
async function stripeWebhook(payload, { sign = true } = {}) {
  const secret = process.env.DOCHUB_STRIPE_WEBHOOK_SECRET;
  const { createHmac } = await import('node:crypto');
  const t = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify(payload);
  const v1 = sign ? createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex') : 'deadbeef';
  const res = await fetch(`${BASE}/api/v1/stripe-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
    body: raw,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const rnd = Math.random().toString(36).slice(2, 8);
const A = `alice-${rnd}@example.com`, B = `bob-${rnd}@example.com`;

console.log('\n— auth —');
let r = await call('a', 'POST', '/api/v1/users/registrations/sign_up.json', { email: A, password: 'test-pass-123', name: 'Alice' });
ok('sign up', r.status === 200 && r.json.user.plan === 'free', JSON.stringify(r.json));
r = await call('a', 'GET', '/api/v1/users/show-initial-payload');
ok('initial payload has entitlements', r.json.entitlements?.plan === 'free');
ok('free plan has no document cap', r.json.entitlements.limits.documents_completed === null);
ok('free plan excludes whiteout', r.json.entitlements.features.pdf_markup_advanced === false);
r = await call('a', 'POST', '/api/v1/users/registrations/sign_up.json', { email: A, password: 'test-pass-123' });
ok('duplicate email rejected', r.status === 409);

console.log('\n— guest sessions —');
r = await call('g', 'POST', '/api/v1/users/find-or-create-guest', {});
ok('guest session without signing up', r.status === 200 && r.json.user.is_guest === true, JSON.stringify(r.json));
const guestId = r.json.user.id;
r = await call('g', 'GET', '/api/v1/users/show-initial-payload');
ok('guest gets the free plan uncapped', r.json.entitlements.limits.documents_completed === null);
r = await call('g', 'POST', '/api/v1/documents/create-blank', { title: 'guest work' });
ok('guest can create a document', r.status === 200, JSON.stringify(r.json));
r = await call('g', 'GET', '/api/v1/users/show-initial-payload');
ok('guest session survives a new request with only the cookie', r.json.user.id === guestId);
r = await call('g', 'POST', '/api/v1/users/registrations/sign_up.json', { email: A, password: 'test-pass-123' });
ok('signing up onto a taken email is refused', r.status === 409, JSON.stringify(r.json));
const claimed = `claimed-${rnd}@example.com`;
r = await call('g', 'POST', '/api/v1/users/registrations/sign_up.json', { email: claimed, password: 'test-pass-123', name: 'Claimed' });
ok('guest converts in place on sign up', r.status === 200 && r.json.user.id === guestId && r.json.user.is_guest === false, JSON.stringify(r.json));
r = await call('g', 'GET', '/api/v1/documents?scope=documents');
ok('work made as a guest carries over', r.json.documents.some((d) => d.title === 'guest work'));

console.log('\n— documents —');
r = await call('a', 'POST', '/api/v1/documents/create-blank', { title: 'Test doc', page_count: 2 });
const doc = r.json.document;
ok('create blank document', r.status === 200 && doc.pages.length === 2);
const pageId = doc.pages[0].id;

r = await call('a', 'POST', '/api/v1/annotations/update-many', {
  document_id: doc.id,
  created: [{ page_id: pageId, type: 'text', x: .1, y: .1, w: .3, h: .04, data: { text: 'Hello' } }],
});
ok('create text annotation', r.json.annotations?.length === 1);

r = await call('a', 'POST', '/api/v1/annotations/update-many', {
  document_id: doc.id, created: [{ page_id: pageId, type: 'whiteout', x: .2, y: .2, w: .2, h: .05 }],
});
ok('whiteout gated on Free (402)', r.status === 402 && r.json.error.required_plan === 'basic', JSON.stringify(r.json));

console.log('\n— form fields + validation —');
r = await call('a', 'POST', '/api/v1/formfields/create-many', {
  document_id: doc.id,
  formfields: [
    { page_id: pageId, type: 'text', name: 'who', x: .1, y: .3, w: .3, h: .04, required: true },
    { page_id: pageId, type: 'signature', name: 'sig', x: .1, y: .4, w: .25, h: .06, required: true },
  ],
});
ok('create fields', r.json.formfields?.length === 2);
const fields = r.json.formfields;

r = await call('a', 'POST', '/api/v1/formfields/create-many', {
  document_id: doc.id,
  formfields: [{ page_id: pageId, type: 'text', name: 'em', x: .5, y: .3, w: .3, h: .04, validation: 'email' }],
});
ok('advanced validation gated on Free', r.status === 402 && r.json.error.feature === 'advanced_validation');

r = await call('a', 'POST', '/api/v1/documents/' + doc.id + '/complete', {});
ok('complete blocked while required fields empty', r.status === 400, JSON.stringify(r.json));

console.log('\n— signatures + metering —');
r = await call('a', 'POST', '/api/v1/signatures/create-with-svg-data', { svg_data: '<svg/>', kind: 'signature' });
const sig = r.json.signature;
ok('store signature', !!sig?.id);
r = await call('a', 'POST', `/api/v1/documents/${doc.id}/self-sign`, {
  signature_id: sig.id, page_id: pageId, x: .1, y: .4, field_id: fields[1].id,
});
ok('self-sign applies and meters', r.status === 200);
r = await call('a', 'GET', '/api/v1/users/show-initial-payload');
ok('self-signature metered (1/5)', r.json.usage.self_signatures.used === 1, JSON.stringify(r.json.usage.self_signatures));

await call('a', 'POST', '/api/v1/formfields/update-many', { document_id: doc.id, formfields: [{ id: fields[0].id, value: 'Alice' }] });
r = await call('a', 'POST', `/api/v1/documents/${doc.id}/complete`, {});
ok('complete succeeds once filled', r.status === 200 && r.json.document.state === 'completed', JSON.stringify(r.json));

console.log('\n— uncapped free completions —');
for (let i = 0; i < 4; i++) {
  const d = (await call('a', 'POST', '/api/v1/documents/create-blank', { title: `cap ${i}` })).json.document;
  r = await call('a', 'POST', `/api/v1/documents/${d.id}/complete`, {});
  ok(`completion ${i + 2} allowed past the old cap of 3`, r.status === 200, JSON.stringify(r.json));
}
r = await call('a', 'GET', '/api/v1/users/show-initial-payload');
ok('usage reports no limit to meter', r.json.usage.documents_completed.limit === null);

console.log('\n— signature request + signer flow —');
r = await call('a', 'POST', '/api/v1/sign-requests/create-with-document-roles', {
  document_id: doc.id, subject: 'Sign this', signers: [{ email: B, name: 'Bob', role_name: 'Signer 1' }],
});
ok('create sign request', r.status === 200 && r.json.signers.length === 1, JSON.stringify(r.json));
const emails = (await call('a', 'GET', '/api/v1/email-records')).json.email_records;
const link = emails.map((e) => (e.body.match(/\/sign\/([a-f0-9]+)/) || [])[1]).find(Boolean);
ok('signing link recorded in email log', !!link);

r = await call('s', 'GET', `/api/v1/sign/${link}`);
ok('signer opens document without an account', r.status === 200 && r.json.document.id === doc.id);
ok('signer sees the form fields', r.json.formfields.length >= 2);

r = await call('s', 'POST', `/api/v1/sign/${link}/fields`, { formfields: [{ id: fields[0].id, value: 'Bob' }] });
ok('signer fills a field', r.status === 200);
r = await call('s', 'POST', `/api/v1/sign/${link}/complete`, { page_id: pageId, signature_png: 'data:image/png;base64,iVBORw0KGgo=' });
ok('signer completes', r.status === 200 && r.json.signed === true, JSON.stringify(r.json));
r = await call('s', 'GET', `/api/v1/sign/${link}`);
ok('signed state persisted', r.json.signer.state === 'signed');

console.log('\n— audit trail —');
r = await call('a', 'GET', `/api/v1/documents/${doc.id}/audit`);
const actions = r.json.activities.map((x) => x.action);
ok('audit records creation', actions.includes('document.created'));
ok('audit records sign request', actions.includes('sign_request.sent'));
ok('audit records signer view + signature', actions.includes('signer.viewed') && actions.includes('signer.signed'));
ok('audit hides signer access tokens', r.json.signers.every((s) => s.access_token === undefined));

console.log('\n— paid features after upgrade —');
// How an account reaches Pro depends on the payment mode: locally in
// internal-test mode, and only through a Stripe webhook in Stripe mode.
const payment = (await call('a', 'GET', '/api/v1/stripe-plans')).json.payment;
let upgraded = false;
if (payment.provider !== 'stripe') {
  r = await call('a', 'POST', '/api/v1/stripe-checkout/create-checkout-session-with-subscription', { plan: 'pro', period: 'yearly' });
  ok('plan change applies locally', r.status === 200 && r.json.applied === true, JSON.stringify(r.json));
  ok('plan change is labelled test-mode', /no real payment/i.test(r.json.note || ''));
  upgraded = r.status === 200 && r.json.applied === true;
} else if (process.env.DOCHUB_STRIPE_WEBHOOK_SECRET) {
  const me = (await call('a', 'GET', '/api/v1/users/show-initial-payload')).json.user;
  const w = await stripeWebhook({ type: 'checkout.session.completed', data: { object: {
    id: `cs_up_${rnd}`, client_reference_id: me.id, customer: `cus_up_${rnd}`,
    subscription: `sub_up_${rnd}`, metadata: { dochub_user_id: me.id, plan: 'pro', period: 'yearly' } } } });
  ok('Stripe webhook grants the purchased plan', w.status === 200 && w.json.plan === 'pro', JSON.stringify(w.json));
  upgraded = w.status === 200 && w.json.plan === 'pro';
} else {
  skip('upgrade to Pro', 'Stripe mode without DOCHUB_STRIPE_WEBHOOK_SECRET for the test process');
}

if (!upgraded) skip('Pro feature coverage', 'the account could not be upgraded in this payment mode');
else {
  r = await call('a', 'POST', '/api/v1/annotations/update-many', {
    document_id: doc.id, created: [{ page_id: pageId, type: 'whiteout', x: .2, y: .2, w: .2, h: .05 }],
  });
  ok('whiteout allowed on Pro', r.status === 200);
  r = await call('a', 'POST', '/api/v1/sign-requests/bulk-send', {
    document_id: doc.id, subject: 'Bulk', recipients: [{ email: `c1-${rnd}@example.com`, name: 'C1' }, { email: `c2-${rnd}@example.com`, name: 'C2' }],
  });
  ok('bulk send allowed on Pro', r.status === 200 && r.json.sent === 2, JSON.stringify(r.json));
  r = await call('a', 'POST', `/api/v1/documents/${doc.id}/certify`, {});
  ok('certification produces a content hash', /^[a-f0-9]{64}$/.test(r.json.certificate_hash || ''));
  r = await call('a', 'POST', '/api/v1/compiled-pdfs/verify', { document_id: doc.id, hash: r.json.certificate_hash });
  ok('certificate verifies', r.json.matches === true);

  console.log('\n— password protection —');
  r = await call('a', 'POST', `/api/v1/documents/${doc.id}/password`, { password: 'hunter2hunter2' });
  ok('set document password (Pro)', r.json.password_protected === true);
  r = await call('x', 'GET', `/api/v1/documents/${doc.id}`);
  ok('unauthenticated access refused', r.status === 401 || r.status === 403 || r.status === 423, String(r.status));

  console.log('\n— fax —');
  r = await call('a', 'POST', '/api/v1/outbound-faxes', { document_id: doc.id, to_number: '+15551234567', pages: 1 });
  ok('fax recorded but not delivered', r.json.outbound_fax?.state === 'failed' && r.json.outbound_fax.error === 'no_carrier_configured', JSON.stringify(r.json));
}

console.log('\n— AI assistant —');
r = await call('a', 'POST', '/api/v1/document-assistant-messages', { document_id: doc.id, transform: 'summarize' });
ok('assistant answers', r.status === 200 && typeof r.json.answer === 'string', JSON.stringify(r.json).slice(0, 200));
ok('assistant labels its provider honestly', /local-extractive|claude/.test(r.json.provider), r.json.provider);

console.log('\n— organization + SSO —');
r = await call('a', 'POST', '/api/v1/organizations', { name: 'Acme' });
ok('create organization', r.status === 200);
if (!upgraded) skip('SAML configuration', 'SSO is a Pro feature and the account is still on Free');
else {
  r = await call('a', 'POST', '/api/v1/saml-settings', { idp_entity_id: 'x', idp_sso_url: 'https://idp', enabled: true });
  ok('SAML config stored (Pro)', r.status === 200 && !!r.json.sp_metadata);
  ok('SP metadata URLs are published', /\/api\/v1\/saml\/acs$/.test(r.json.sp_metadata.acs_url));
  ok('SAML stays inactive until a certificate is set', r.json.assertion_processing === 'inactive', r.json.assertion_processing);
  r = await call('a', 'POST', '/api/v1/organizations/hipaa-baa', { accepted: true });
  ok('HIPAA BAA gated above Pro', r.status === 402 && r.json.error.required_plan === 'site_license', JSON.stringify(r.json));
  r = await call('a', 'POST', '/api/v1/organizations/sub', { name: 'Sub' });
  ok('sub-organizations gated above Pro', r.status === 402);
}

// --- provider seams -------------------------------------------------------
// Each section exercises the real integration when its environment is present
// and otherwise checks the honest fallback, so the suite stays green either way.
console.log('\n— email delivery —');
r = await call('a', 'GET', '/api/v1/email-records');
const delivery = r.json.delivery;
ok('email log reports its delivery mode', !!delivery?.mode, JSON.stringify(delivery));
if (delivery.mode === 'smtp') {
  ok('SMTP transport is described', delivery.configured === true && !!delivery.host, JSON.stringify(delivery));
  const probe = `smtp-${rnd}@example.com`;
  await call('a', 'POST', '/api/v1/organization-roles/create-with-emails', { emails: [probe] });
  const rec = (await call('a', 'GET', '/api/v1/email-records')).json.email_records.find((e) => e.to_email === probe);
  ok('SMTP send reports a real outcome', ['sent', 'failed'].includes(rec?.state), JSON.stringify(rec));
  if (rec?.state === 'sent') ok('accepted message carries the transport id', !!rec.message_id, JSON.stringify(rec));
  else ok('failed send records the transport error', !!rec?.error, JSON.stringify(rec));
} else {
  ok('local mode records without claiming delivery',
     r.json.email_records.every((e) => e.state === 'recorded_locally'),
     JSON.stringify(r.json.email_records.map((e) => e.state)));
  skip('SMTP delivery', 'DOCHUB_DELIVERY is not "smtp"');
}

console.log('\n— SAML SSO —');
{
  const mRes = await fetch(`${BASE}/api/v1/saml/metadata`);
  const metadata = await mRes.text();
  ok('SP metadata is served', mRes.status === 200 && /AssertionConsumerService/.test(metadata));
  ok('metadata advertises the ACS endpoint', /\/api\/v1\/saml\/acs/.test(metadata));
  const spEntityId = (metadata.match(/entityID="([^"]+)"/) || [])[1];

  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createSign, createHash } = await import('node:crypto');
  const { parseXml, canonicalise } = await import('../server/xmlsig.js');

  let keys = null;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dochub-saml-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=dochub-e2e-idp', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')],
      { stdio: 'ignore' });
    keys = { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } catch { /* reported as a skip below */ }

  if (!upgraded) {
    skip('SAML assertion flow', 'SSO is a Pro feature and the account is still on Free');
    keys = null;
  }
  const domain = `saml-${rnd}.example`;
  const ds = keys ? await call('a', 'POST', '/api/v1/domain-settings', { domain_name: domain }) : null;
  let verify = { json: {} };
  if (keys) {
    ok('domain added for SSO', ds.status === 200 && !!ds.json.domain_setting);
    verify = await call('a', 'POST', `/api/v1/domain-settings/${ds.json.domain_setting.id}/verify`, {});
    ok('domain verification reports its method', ['dns-txt', 'manual-override'].includes(verify.json.method),
       JSON.stringify(verify.json));
  }

  if (!keys) skip('SAML assertion flow', 'openssl is not available');
  else if (!verify.json.verified) skip('SAML assertion flow', 'the test domain is not verified (set DOCHUB_DOMAIN_VERIFY=manual)');
  else {
    const certB64 = keys.cert.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const idpEntity = 'https://idp.example/metadata';
    r = await call('a', 'POST', '/api/v1/saml-settings', {
      idp_entity_id: idpEntity, idp_sso_url: 'https://idp.example/sso',
      idp_certificate: certB64, enabled: true,
    });
    ok('SAML turns active once a certificate is stored', r.json.assertion_processing === 'active', JSON.stringify(r.json));

    const email = `sso-user-${rnd}@${domain}`;
    r = await call('a', 'POST', '/api/v1/saml/login', { email });
    ok('login discovery returns an IdP redirect', r.json.sso === true && /SAMLRequest=/.test(r.json.redirect_url || ''),
       JSON.stringify(r.json));

    const acs = `${BASE}/api/v1/saml/acs`;
    const iso = (ms) => new Date(Date.now() + ms).toISOString();
    const assertionOf = (addr) => '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"'
      + ` ID="_a${rnd}" IssueInstant="${iso(0)}" Version="2.0">`
      + `<saml:Issuer>${idpEntity}</saml:Issuer>`
      + '<saml:Subject>'
      + `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${addr}</saml:NameID>`
      + '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
      + `<saml:SubjectConfirmationData NotOnOrAfter="${iso(3e5)}" Recipient="${acs}"></saml:SubjectConfirmationData>`
      + '</saml:SubjectConfirmation></saml:Subject>'
      + `<saml:Conditions NotBefore="${iso(-3e5)}" NotOnOrAfter="${iso(3e5)}">`
      + `<saml:AudienceRestriction><saml:Audience>${spEntityId}</saml:Audience></saml:AudienceRestriction>`
      + '</saml:Conditions>'
      + `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${addr}</saml:AttributeValue>`
      + '</saml:Attribute></saml:AttributeStatement></saml:Assertion>';

    function signedResponse(addr) {
      const assertion = assertionOf(addr);
      const digest = createHash('sha256').update(canonicalise(parseXml(assertion)), 'utf8').digest('base64');
      const signedInfo = '<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">'
        + '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod>'
        + '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>'
        + `<ds:Reference URI="#_a${rnd}"><ds:Transforms>`
        + '<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform>'
        + '<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform></ds:Transforms>'
        + '<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>'
        + `<ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
      const sigValue = createSign('RSA-SHA256')
        .update(canonicalise(parseXml(signedInfo)), 'utf8').sign(keys.key).toString('base64');
      const signature = '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">' + signedInfo
        + `<ds:SignatureValue>${sigValue}</ds:SignatureValue>`
        + `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certB64}</ds:X509Certificate>`
        + '</ds:X509Data></ds:KeyInfo></ds:Signature>';
      const signedAssertion = assertion.replace(`</saml:Issuer>`, `</saml:Issuer>${signature}`);
      const response = '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"'
        + ` Destination="${acs}" ID="_r${rnd}" IssueInstant="${iso(0)}" Version="2.0">`
        + '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"></samlp:StatusCode>'
        + `</samlp:Status>${signedAssertion}</samlp:Response>`;
      return Buffer.from(response, 'utf8').toString('base64');
    }

    const postAcs = async (b64) => {
      const res = await fetch(`${BASE}/api/v1/saml/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ SAMLResponse: b64, RelayState: '/' }),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    let acsRes = await postAcs(signedResponse(email));
    ok('signed assertion signs the user in', acsRes.status === 200 && acsRes.json?.signed_in === true,
       JSON.stringify(acsRes.json).slice(0, 300));
    ok('asserted email maps onto a provisioned user', acsRes.json?.user?.email === email, JSON.stringify(acsRes.json?.user));

    const tampered = Buffer.from(
      Buffer.from(signedResponse(email), 'base64').toString('utf8')
        .replace(`>${email}<`, `>attacker-${rnd}@${domain}<`), 'utf8').toString('base64');
    acsRes = await postAcs(tampered);
    ok('a tampered assertion is refused', acsRes.status === 403 && /signature|digest/i.test(acsRes.json?.error?.message || ''),
       JSON.stringify(acsRes.json));

    const unsigned = Buffer.from(
      Buffer.from(signedResponse(email), 'base64').toString('utf8')
        .replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, ''), 'utf8').toString('base64');
    acsRes = await postAcs(unsigned);
    ok('an unsigned assertion is refused', acsRes.status === 403, JSON.stringify(acsRes.json));

    const foreign = Buffer.from(
      Buffer.from(signedResponse(email), 'base64').toString('utf8')
        .replace(`>${email}<`, '>outsider@not-this-domain.example<'), 'utf8').toString('base64');
    acsRes = await postAcs(foreign);
    ok('an assertion for an unverified domain is refused',
       [400, 403].includes(acsRes.status) && /verified domain/i.test(acsRes.json?.error?.message || ''),
       JSON.stringify(acsRes.json));

    // sso_enforced closes the password door for that organization.
    r = await call('a', 'POST', '/api/v1/organizations/sso-enforced', { enforced: true });
    ok('SSO enforcement can be turned on', r.json.sso_enforced === true);
    r = await call('z', 'POST', '/api/v1/users/sessions/sign-in', { email: A, password: 'test-pass-123' });
    ok('password sign-in refused while SSO is enforced', r.status === 403 && /single sign-on/i.test(r.json.error.message),
       JSON.stringify(r.json));
    await call('a', 'POST', '/api/v1/organizations/sso-enforced', { enforced: false });
  }
}

console.log('\n— cloud OAuth —');
{
  r = await call('a', 'GET', '/api/v1/integrations');
  const list = r.json.integrations;
  ok('integrations list their scopes', list.every((i) => Array.isArray(i.scopes) && i.scopes.length));
  const ready = list.filter((i) => i.credentials_configured);
  const unset = list.find((i) => !i.credentials_configured);
  if (unset) {
    r = await call('a', 'POST', `/api/v1/integrations/${unset.provider}/connect`, {});
    ok('connect refuses and names the missing env vars',
       r.status === 400 && unset.missing_env.every((v) => r.json.error.message.includes(v)),
       JSON.stringify(r.json));
    r = await call('a', 'GET', `/api/v1/integrations/${unset.provider}/files`);
    ok('file listing refuses when not connected', r.status === 400 && /not connected/i.test(r.json.error.message));
  }
  if (!ready.length) skip('OAuth authorization flow', 'no provider has both its client id and secret set');
  for (const i of ready) {
    r = await call('a', 'POST', `/api/v1/integrations/${i.provider}/connect`, {});
    const u = r.status === 200 ? new URL(r.json.authorize_url) : null;
    ok(`${i.provider}: connect returns an authorization URL`, !!u, JSON.stringify(r.json).slice(0, 200));
    if (!u) continue;
    ok(`${i.provider}: authorization URL carries the OAuth parameters`,
       u.searchParams.get('response_type') === 'code' && !!u.searchParams.get('client_id')
       && !!u.searchParams.get('state') && u.searchParams.get('scope') === i.scopes.join(' '),
       u.search);
    const cb = await fetch(`${BASE}/api/v1/integrations/callback?state=not-a-real-state&code=x`,
      { headers: { accept: 'application/json' } });
    ok(`${i.provider}: callback rejects an unknown state`, cb.status === 400);
  }
}

console.log('\n— billing —');
{
  r = await call('a', 'GET', '/api/v1/stripe-plans');
  const payment = r.json.payment;
  ok('plan list reports the payment provider', !!payment?.provider, JSON.stringify(payment));
  if (payment.provider === 'stripe') {
    ok('Stripe mode reports its key mode and webhook state',
       ['test', 'live'].includes(payment.key_mode) && typeof payment.webhook_configured === 'boolean',
       JSON.stringify(payment));
    r = await call('a', 'POST', '/api/v1/stripe-checkout/create-checkout-session-with-subscription',
      { plan: 'pro', period: 'monthly' });
    if (r.status === 200 && r.json.checkout_required) {
      ok('checkout returns a Stripe-hosted session', /^https:\/\//.test(r.json.checkout_url || ''), r.json.checkout_url);
      ok('the plan is not granted before the webhook', r.json.applied === false);
    } else {
      ok('missing price id is reported plainly', r.status === 400 && /DOCHUB_STRIPE_PRICE/.test(r.json.error.message),
         JSON.stringify(r.json));
    }
    const secret = process.env.DOCHUB_STRIPE_WEBHOOK_SECRET;
    if (!secret) skip('webhook delivery', 'DOCHUB_STRIPE_WEBHOOK_SECRET is not set for the test process');
    else {
      const send = (payload, sign = true) => stripeWebhook(payload, { sign });
      let w = await send({ type: 'ping', data: { object: {} } }, false);
      ok('webhook rejects a bad signature', w.status === 400 && /signature/i.test(w.json?.error?.message || ''),
         JSON.stringify(w.json));
      w = await send({ type: 'invoice.paid', data: { object: { id: `in_e2e_${rnd}`, customer: 'cus_missing',
        amount_paid: 1000, currency: 'usd', status: 'paid' } } });
      ok('webhook accepts a signed event', w.status === 200 && w.json.received === true, JSON.stringify(w.json));

      // Applying a plan needs the API to answer for a subscription id we invent,
      // so it only runs against a Stripe test double.
      if (!process.env.DOCHUB_STRIPE_API_BASE) {
        skip('webhook applies the plan', 'DOCHUB_STRIPE_API_BASE is not pointed at a Stripe test double');
      } else {
        const me = (await call('a', 'GET', '/api/v1/users/show-initial-payload')).json.user;
        w = await send({ type: 'checkout.session.completed', data: { object: {
          id: `cs_e2e_${rnd}`, client_reference_id: me.id, customer: `cus_e2e_${rnd}`,
          subscription: `sub_e2e_${rnd}`, metadata: { dochub_user_id: me.id, plan: 'pro', period: 'monthly' },
        } } });
        ok('webhook applies the purchased plan', w.status === 200 && w.json.applied === true && w.json.plan === 'pro',
           JSON.stringify(w.json));
        const after = (await call('a', 'GET', '/api/v1/pro-subscriptions')).json;
        ok('subscription is recorded against the Stripe id',
           after.subscriptions.some((x) => x.external_id === `sub_e2e_${rnd}` && x.provider === 'stripe'),
           JSON.stringify(after.subscriptions.slice(0, 2)));
        w = await send({ type: 'customer.subscription.deleted', data: { object: {
          id: `sub_e2e_${rnd}`, customer: `cus_e2e_${rnd}`, status: 'canceled',
          metadata: { dochub_user_id: me.id, plan: 'pro', period: 'monthly' } } } });
        ok('cancellation webhook drops the plan back to Free', w.status === 200 && w.json.plan === 'free',
           JSON.stringify(w.json));
        const sync = await call('a', 'POST', '/api/v1/stripe-invoices/sync', {});
        ok('invoice sync pulls invoices from Stripe', sync.status === 200 && sync.json.provider === 'stripe'
           && typeof sync.json.synced === 'number', JSON.stringify(sync.json).slice(0, 200));
      }
    }
  } else {
    ok('internal-test mode is labelled', payment.provider === 'internal-test' && payment.live === false,
       JSON.stringify(payment));
    r = await call('a', 'POST', '/api/v1/stripe-webhook', { type: 'invoice.paid' });
    ok('webhook refuses outside Stripe mode', r.status === 400 && /not in Stripe mode/i.test(r.json.error.message),
       JSON.stringify(r.json));
    r = await call('a', 'POST', '/api/v1/stripe-invoices/sync', {});
    ok('invoice sync says it has nothing to sync from', r.json.synced === 0 && /Stripe mode/i.test(r.json.note),
       JSON.stringify(r.json));
    skip('Stripe checkout + webhook', 'DOCHUB_PAYMENT_PROVIDER is not "stripe"');
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
