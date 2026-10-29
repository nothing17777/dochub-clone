// Stamp library. DocHub advertises "600+ stamps"; this build generates an
// equivalent-size library from labels x shapes x palettes rather than shipping
// traced copies of theirs.
const LABELS = [
  'APPROVED', 'NOT APPROVED', 'REVIEWED', 'FOR REVIEW', 'DRAFT', 'FINAL', 'VOID', 'PAID',
  'UNPAID', 'OVERDUE', 'CONFIDENTIAL', 'URGENT', 'COPY', 'ORIGINAL', 'RECEIVED', 'SENT',
  'COMPLETED', 'PENDING', 'REJECTED', 'ACCEPTED', 'VERIFIED', 'CERTIFIED', 'EXPIRED',
  'CANCELLED', 'ON HOLD', 'IN PROGRESS', 'SIGNED', 'WITNESSED', 'NOTARIZED', 'FILED',
  'ARCHIVED', 'SAMPLE', 'TOP SECRET', 'INTERNAL USE', 'DO NOT COPY', 'REVISED',
  'SUPERSEDED', 'AS BUILT', 'PRELIMINARY', 'ISSUED', 'CHECKED', 'PROCESSED',
  'ENTERED', 'POSTED', 'CLOSED', 'OPEN', 'PRIORITY', 'FRAGILE', 'EMERGENCY', 'DUPLICATE',
];
const SHAPES = ['rect', 'round', 'banner'];
const PALETTES = [
  { id: 'red', ink: '#c62828' }, { id: 'green', ink: '#2e7d32' },
  { id: 'blue', ink: '#1565c0' }, { id: 'black', ink: '#263238' },
];
const CATEGORY = (label) => {
  if (/PAID|UNPAID|OVERDUE|POSTED|PROCESSED|ENTERED/.test(label)) return 'accounting';
  if (/SIGNED|WITNESSED|NOTARIZED|CERTIFIED|VERIFIED|FILED/.test(label)) return 'legal';
  if (/APPROVED|REVIEWED|REJECTED|ACCEPTED|CHECKED/.test(label)) return 'approval';
  if (/CONFIDENTIAL|SECRET|INTERNAL|DO NOT COPY/.test(label)) return 'security';
  if (/DRAFT|FINAL|REVISED|SUPERSEDED|PRELIMINARY|AS BUILT|SAMPLE/.test(label)) return 'revision';
  return 'general';
};

function svgFor(label, shape, ink) {
  const w = Math.max(150, 20 + label.length * 15), h = 54;
  const frame = shape === 'round'
    ? `<rect x="4" y="4" width="${w - 8}" height="${h - 8}" rx="24" fill="none" stroke="${ink}" stroke-width="4"/>`
    : shape === 'banner'
      ? `<path d="M4 8 H${w - 4} L${w - 22} ${h / 2} L${w - 4} ${h - 8} H4 Z" fill="none" stroke="${ink}" stroke-width="4"/>`
      : `<rect x="4" y="4" width="${w - 8}" height="${h - 8}" fill="none" stroke="${ink}" stroke-width="4"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`
    + `${frame}<text x="${w / 2}" y="${h / 2 + 7}" text-anchor="middle" fill="${ink}"`
    + ` font-family="Helvetica,Arial,sans-serif" font-size="22" font-weight="700"`
    + ` letter-spacing="1.5">${label}</text></svg>`;
}

export const STAMPS = LABELS.flatMap((label) =>
  SHAPES.flatMap((shape) =>
    PALETTES.map((p) => ({
      id: `stamp-${label.toLowerCase().replace(/\s+/g, '-')}-${shape}-${p.id}`,
      name: label, category: CATEGORY(label), shape, color: p.id,
      svg: svgFor(label, shape, p.ink), builtin: 1, owner_id: null,
    }))));

export const STAMP_COUNT = STAMPS.length;
