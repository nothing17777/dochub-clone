// A small XML parser, exclusive canonicaliser and XML-DSig verifier.
// Enough of the specs to validate the SAML assertions IdPs actually send:
// RSA-SHA1/SHA256 signatures, enveloped-signature + (exclusive) c14n
// transforms. Anything outside that is rejected loudly rather than skipped.
import { createVerify, createHash, X509Certificate } from 'node:crypto';

const XMLNS = 'http://www.w3.org/2000/xmlns/';

// --- parser ---------------------------------------------------------------
// Produces { name, prefix, local, attrs:[{name,prefix,local,value}], children, parent, text }
export function parseXml(src) {
  let i = 0;
  const root = { children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const text = src.slice(i, lt);
      if (text.trim() || stack.length > 1) top().children.push({ type: 'text', value: decodeEntities(text) });
    }
    if (src.startsWith('<!--', lt)) { i = src.indexOf('-->', lt) + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      top().children.push({ type: 'text', value: src.slice(lt + 9, end) });
      i = end + 3; continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) { i = src.indexOf('>', lt) + 1; continue; }
    if (src.startsWith('</', lt)) {
      i = src.indexOf('>', lt) + 1;
      if (stack.length > 1) stack.pop();
      continue;
    }
    const end = findTagEnd(src, lt);
    const raw = src.slice(lt + 1, end).trim();
    const selfClosing = raw.endsWith('/');
    const inner = selfClosing ? raw.slice(0, -1) : raw;
    const el = makeElement(inner);
    el.parent = top() === root ? null : top();
    top().children.push(el);
    if (!selfClosing) stack.push(el);
    i = end + 1;
  }
  const doc = root.children.find((c) => c.type === 'element');
  if (!doc) throw new Error('No XML element found');
  return doc;
}

function findTagEnd(src, from) {
  let q = null;
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '>') return i;
  }
  throw new Error('Unterminated XML tag');
}

function makeElement(inner) {
  const m = /^([^\s/>]+)/.exec(inner);
  const name = m[1];
  const attrs = [];
  const rx = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let a;
  while ((a = rx.exec(inner.slice(name.length)))) {
    const value = decodeEntities(a[3] !== undefined ? a[3] : a[4]);
    attrs.push({ name: a[1], ...split(a[1]), value });
  }
  return { type: 'element', name, ...split(name), attrs, children: [], parent: null };
}

const split = (n) => {
  const i = n.indexOf(':');
  return i < 0 ? { prefix: '', local: n } : { prefix: n.slice(0, i), local: n.slice(i + 1) };
};

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

// --- tree helpers ---------------------------------------------------------
export function* walk(el) {
  yield el;
  for (const c of el.children) if (c.type === 'element') yield* walk(c);
}
export const findAll = (el, local, ns = null) =>
  [...walk(el)].filter((e) => e.local === local && (!ns || nsOf(e, e.prefix) === ns));
export const find = (el, local, ns = null) => findAll(el, local, ns)[0] || null;
export const attr = (el, name) => el.attrs.find((a) => a.name === name || a.local === name)?.value ?? null;
export const textOf = (el) => el.children.filter((c) => c.type === 'text').map((c) => c.value).join('');

export function nsOf(el, prefix) {
  for (let n = el; n; n = n.parent) {
    for (const a of n.attrs) {
      if (prefix === '' && a.name === 'xmlns') return a.value;
      if (prefix && a.prefix === 'xmlns' && a.local === prefix) return a.value;
    }
  }
  return prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : '';
}

// --- canonicalisation -----------------------------------------------------
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  .replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

/** Canonicalise `el` as a subtree. `exclusive` picks exc-c14n (the default for
 *  SAML); `inclusivePrefixes` is the InclusiveNamespaces PrefixList, if any.
 *  `omit` is a node excluded from the output (the enveloped signature). */
export function canonicalise(el, { exclusive = true, inclusivePrefixes = [], omit = null } = {}) {
  const out = [];
  render(el, out, exclusive, new Set(inclusivePrefixes), new Map(), omit);
  return out.join('');
}

function render(el, out, exclusive, inclusive, renderedNs, omit) {
  if (el === omit) return;
  if (el.type === 'text') { out.push(escText(el.value)); return; }

  const used = new Set([el.prefix]);
  for (const a of el.attrs) if (a.prefix && a.prefix !== 'xmlns') used.add(a.prefix);
  for (const p of inclusive) used.add(p === '#default' ? '' : p);

  const decls = [];
  const localRendered = new Map(renderedNs);
  const candidates = exclusive
    ? [...used]
    : [...used, ...inScopePrefixes(el)];
  for (const prefix of new Set(candidates)) {
    const uri = nsOf(el, prefix);
    if (prefix === '' && uri === '' && !renderedNs.has('')) continue;
    if (localRendered.get(prefix) === uri) continue;
    localRendered.set(prefix, uri);
    decls.push(prefix === '' ? ` xmlns="${escAttr(uri)}"` : ` xmlns:${prefix}="${escAttr(uri)}"`);
  }
  decls.sort();

  const attrs = el.attrs
    .filter((a) => a.name !== 'xmlns' && a.prefix !== 'xmlns')
    .map((a) => ({ ...a, uri: a.prefix ? nsOf(el, a.prefix) : '' }))
    .sort((x, y) => (x.uri === y.uri ? (x.local < y.local ? -1 : 1) : x.uri < y.uri ? -1 : 1))
    .map((a) => ` ${a.name}="${escAttr(a.value)}"`);

  out.push(`<${el.name}${decls.join('')}${attrs.join('')}>`);
  for (const c of el.children) render(c, out, exclusive, inclusive, localRendered, omit);
  out.push(`</${el.name}>`);
}

function inScopePrefixes(el) {
  const seen = new Set();
  for (let n = el; n; n = n.parent) {
    for (const a of n.attrs) {
      if (a.name === 'xmlns') seen.add('');
      else if (a.prefix === 'xmlns') seen.add(a.local);
    }
  }
  return [...seen];
}

// --- signature verification ----------------------------------------------
const DIGEST = {
  'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'sha512',
  'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1',
};
const SIGALG = {
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'RSA-SHA256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'RSA-SHA512',
  'http://www.w3.org/2000/09/xmldsig#rsa-sha1': 'RSA-SHA1',
};
const C14N_EXCLUSIVE = ['http://www.w3.org/2001/10/xml-exc-c14n#', 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments'];
const C14N_INCLUSIVE = ['http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
                        'http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments'];

export const certToPem = (b64) =>
  `-----BEGIN CERTIFICATE-----\n${String(b64).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
    .replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;

/** Verify the enveloped signature on `signed` (an element carrying a direct
 *  ds:Signature child) against `certPem`. Throws with a specific reason. */
export function verifySignature(signed, certPem) {
  const sig = signed.children.find((c) => c.type === 'element' && c.local === 'Signature');
  if (!sig) throw new Error('no signature on the signed element');
  const signedInfo = find(sig, 'SignedInfo');
  if (!signedInfo) throw new Error('signature has no SignedInfo');

  const sigAlg = SIGALG[attr(find(signedInfo, 'SignatureMethod'), 'Algorithm')];
  if (!sigAlg) throw new Error(`unsupported signature algorithm ${attr(find(signedInfo, 'SignatureMethod'), 'Algorithm')}`);

  const reference = find(signedInfo, 'Reference');
  if (!reference) throw new Error('SignedInfo has no Reference');
  const uri = attr(reference, 'URI') || '';
  const id = attr(signed, 'ID') || attr(signed, 'Id');
  if (uri && uri !== `#${id}`) throw new Error(`signature reference ${uri} does not cover the assertion`);

  const transforms = findAll(reference, 'Transform').map((t) => attr(t, 'Algorithm'));
  let enveloped = false, exclusive = true, inclusivePrefixes = [];
  for (const t of transforms) {
    if (t === 'http://www.w3.org/2000/09/xmldsig#enveloped-signature') { enveloped = true; continue; }
    if (C14N_EXCLUSIVE.includes(t)) { exclusive = true; continue; }
    if (C14N_INCLUSIVE.includes(t)) { exclusive = false; continue; }
    throw new Error(`unsupported transform ${t}`);
  }
  if (!enveloped) throw new Error('reference is not an enveloped-signature');
  const incl = find(reference, 'InclusiveNamespaces');
  if (incl) inclusivePrefixes = (attr(incl, 'PrefixList') || '').split(/\s+/).filter(Boolean);

  const digestAlg = DIGEST[attr(find(reference, 'DigestMethod'), 'Algorithm')];
  if (!digestAlg) throw new Error('unsupported digest algorithm');
  const expected = textOf(find(reference, 'DigestValue')).trim();
  const actual = createHash(digestAlg)
    .update(canonicalise(signed, { exclusive, inclusivePrefixes, omit: sig }), 'utf8')
    .digest('base64');
  if (actual !== expected) throw new Error('assertion digest does not match the signature');

  const siC14n = attr(find(signedInfo, 'CanonicalizationMethod'), 'Algorithm');
  const siExclusive = C14N_EXCLUSIVE.includes(siC14n);
  if (!siExclusive && !C14N_INCLUSIVE.includes(siC14n)) throw new Error(`unsupported canonicalization ${siC14n}`);
  const siIncl = find(signedInfo, 'InclusiveNamespaces');
  const siBytes = canonicalise(signedInfo, {
    exclusive: siExclusive,
    inclusivePrefixes: siIncl ? (attr(siIncl, 'PrefixList') || '').split(/\s+/).filter(Boolean) : [],
  });

  const key = new X509Certificate(certPem).publicKey;
  const sigValue = Buffer.from(textOf(find(sig, 'SignatureValue')).replace(/\s+/g, ''), 'base64');
  if (!createVerify(sigAlg).update(siBytes, 'utf8').verify(key, sigValue)) {
    throw new Error('signature does not verify against the configured IdP certificate');
  }
  return { algorithm: sigAlg, digest: digestAlg, reference: uri };
}
