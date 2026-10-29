// SAML 2.0 service-provider side: metadata, AuthnRequest (HTTP-Redirect) and
// assertion validation at the ACS. Signature checking is real -- an assertion
// that does not verify against the stored idp_certificate is refused.
import { randomUUID, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { db, now } from './db.js';
import { parseXml, find, findAll, attr, textOf, verifySignature, certToPem } from './xmlsig.js';

export const baseUrl = (ctx) =>
  process.env.DOCHUB_BASE_URL || `http://${ctx?.req?.headers?.host || 'localhost:4173'}`;

export const spEntityId = (ctx) => `${baseUrl(ctx)}/api/v1/saml/metadata`;
export const acsUrl = (ctx) => `${baseUrl(ctx)}/api/v1/saml/acs`;

export function spMetadata(ctx) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${spEntityId(ctx)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"
      protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        Location="${acsUrl(ctx)}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
}

/** The org that owns a verified domain matching this email address. */
export function orgForEmail(email) {
  const domain = String(email || '').toLowerCase().split('@')[1];
  if (!domain) return null;
  const row = db.prepare(`SELECT o.* FROM domain_settings d JOIN organizations o ON o.id=d.organization_id
                          WHERE d.domain_name=? AND d.verified=1`).get(domain);
  return row || null;
}

export const samlFor = (orgId) =>
  db.prepare('SELECT * FROM saml_settings WHERE organization_id=?').get(orgId) || null;

/** Build an AuthnRequest and the HTTP-Redirect URL that carries it. */
export function authnRequest(ctx, org, settings, relayState = '/') {
  const id = `_${randomBytes(16).toString('hex')}`;
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"`
    + ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0"`
    + ` IssueInstant="${new Date().toISOString()}" Destination="${settings.idp_sso_url}"`
    + ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`
    + ` AssertionConsumerServiceURL="${acsUrl(ctx)}">`
    + `<saml:Issuer>${spEntityId(ctx)}</saml:Issuer></samlp:AuthnRequest>`;
  db.prepare('INSERT INTO saml_requests (id,organization_id,relay_state,created_at) VALUES (?,?,?,?)')
    .run(id, org.id, relayState, now());
  const url = new URL(settings.idp_sso_url);
  url.searchParams.set('SAMLRequest', deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64'));
  url.searchParams.set('RelayState', relayState);
  return { id, url: url.toString(), xml };
}

export class SamlError extends Error {}

/** Validate a base64 SAMLResponse against the org's stored IdP certificate.
 *  Returns { email, nameId, attributes, signedElement }. */
export function validateResponse(ctx, b64, { settings, org }) {
  if (!settings?.idp_certificate) throw new SamlError('no IdP certificate is configured for this organization');
  let doc;
  try { doc = parseXml(Buffer.from(String(b64), 'base64').toString('utf8')); }
  catch (err) { throw new SamlError(`SAMLResponse is not parseable XML: ${err.message}`); }

  const statusCode = attr(find(doc, 'StatusCode'), 'Value');
  if (statusCode && !/:Success$/.test(statusCode)) throw new SamlError(`IdP returned status ${statusCode}`);

  const assertion = doc.local === 'Assertion' ? doc : find(doc, 'Assertion');
  if (!assertion) throw new SamlError('no Assertion in the SAMLResponse');
  if (find(doc, 'EncryptedAssertion')) {
    throw new SamlError('the assertion is encrypted; this SP accepts signed plaintext assertions only');
  }

  const pem = certToPem(settings.idp_certificate);
  // The signature may sit on the Response, the Assertion, or both. Whichever
  // element carries it must be the one that contains the assertion.
  const signed = assertion.children.some((c) => c.type === 'element' && c.local === 'Signature')
    ? assertion
    : (doc.children.some((c) => c.type === 'element' && c.local === 'Signature') ? doc : null);
  if (!signed) throw new SamlError('neither the Response nor the Assertion is signed');
  try { verifySignature(signed, pem); }
  catch (err) { throw new SamlError(`assertion signature rejected: ${err.message}`); }

  const issuer = textOf(find(assertion, 'Issuer') || { children: [] }).trim();
  if (settings.idp_entity_id && issuer && issuer !== settings.idp_entity_id) {
    throw new SamlError(`assertion issuer ${issuer} is not the configured IdP`);
  }

  const conditions = find(assertion, 'Conditions');
  const clock = Date.now();
  const skew = 60_000;
  if (conditions) {
    const nb = attr(conditions, 'NotBefore'), na = attr(conditions, 'NotOnOrAfter');
    if (nb && clock + skew < Date.parse(nb)) throw new SamlError('assertion is not valid yet');
    if (na && clock - skew >= Date.parse(na)) throw new SamlError('assertion has expired');
    const audiences = findAll(conditions, 'Audience').map((a) => textOf(a).trim());
    if (audiences.length && !audiences.includes(spEntityId(ctx))) {
      throw new SamlError(`assertion audience ${audiences.join(', ')} is not ${spEntityId(ctx)}`);
    }
  }
  for (const c of findAll(assertion, 'SubjectConfirmationData')) {
    const na = attr(c, 'NotOnOrAfter');
    if (na && clock - skew >= Date.parse(na)) throw new SamlError('subject confirmation has expired');
  }

  const nameId = textOf(find(assertion, 'NameID') || { children: [] }).trim();
  const attributes = {};
  for (const a of findAll(assertion, 'Attribute')) {
    const name = attr(a, 'Name') || attr(a, 'FriendlyName');
    if (name) attributes[name] = findAll(a, 'AttributeValue').map((v) => textOf(v).trim());
  }
  const email = (attributes['urn:oid:0.9.2342.19200300.100.1.3']?.[0]
    || attributes.email?.[0] || attributes.Email?.[0] || attributes.mail?.[0]
    || (nameId.includes('@') ? nameId : null) || '').toLowerCase();
  if (!email) throw new SamlError('the assertion carries no email address to map onto a user');

  const domain = email.split('@')[1];
  const verified = db.prepare(`SELECT 1 FROM domain_settings WHERE organization_id=? AND domain_name=? AND verified=1`)
    .get(org.id, domain);
  if (!verified) throw new SamlError(`${domain} is not a verified domain for this organization`);

  return { email, nameId: nameId || email, attributes };
}
