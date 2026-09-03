/**
 * Tenant reference numbers. Patterns are stored per organization so a brokerage can keep
 * its own numbering (for example `LP-LD-2601-000042`).
 */
export const DEFAULT_REFERENCE_PATTERNS = Object.freeze({
  contact: '{PREFIX}-CT-{YY}{MM}-{SEQ}',
  lead: '{PREFIX}-LD-{YY}{MM}-{SEQ}',
  listing: '{PREFIX}-LS-{YY}{MM}-{SEQ}',
  unit: '{PREFIX}-UN-{SEQ}',
  project: '{PREFIX}-PJ-{SEQ}',
  reservation: '{PREFIX}-RS-{YY}{MM}-{SEQ}',
  booking: '{PREFIX}-BK-{YY}{MM}-{SEQ}',
  deal: '{PREFIX}-DL-{YY}{MM}-{SEQ}',
  offer: '{PREFIX}-OF-{YY}{MM}-{SEQ}',
  invoice: '{PREFIX}-INV-{YY}{MM}-{SEQ}',
  payment: '{PREFIX}-PAY-{YY}{MM}-{SEQ}',
  receipt: '{PREFIX}-RCT-{YY}{MM}-{SEQ}',
  refund: '{PREFIX}-RFD-{YY}{MM}-{SEQ}',
  document: '{PREFIX}-DOC-{YY}{MM}-{SEQ}',
});

export function buildReference({
  entity,
  prefix = 'GVZ',
  sequence = 1,
  date = new Date(),
  pattern = null,
  padding = 6,
}) {
  const template = pattern ?? DEFAULT_REFERENCE_PATTERNS[entity] ?? '{PREFIX}-{SEQ}';
  const year = date.getUTCFullYear();
  return template
    .replaceAll('{PREFIX}', prefix)
    .replaceAll('{YYYY}', String(year))
    .replaceAll('{YY}', String(year).slice(-2))
    .replaceAll('{MM}', String(date.getUTCMonth() + 1).padStart(2, '0'))
    .replaceAll('{DD}', String(date.getUTCDate()).padStart(2, '0'))
    .replaceAll('{SEQ}', String(sequence).padStart(padding, '0'));
}

/** Normalizes a phone number to E.164-ish digits so contact dedupe is reliable. */
export function normalizePhone(value, defaultCountryCode = '971') {
  if (!value) return null;
  let digits = String(value).replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith('+')) {
    if (digits.startsWith('0')) digits = `+${defaultCountryCode}${digits.slice(1)}`;
    else if (digits.startsWith(defaultCountryCode)) digits = `+${digits}`;
    else digits = `+${defaultCountryCode}${digits}`;
  }
  return digits;
}

export function normalizeEmail(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase();
}

export function normalizeIdentifier(type, value) {
  switch (type) {
    case 'email':
      return normalizeEmail(value);
    case 'phone':
    case 'whatsapp':
      return normalizePhone(value);
    default:
      return value ? String(value).trim().toUpperCase() : null;
  }
}

/** Stable signature used to detect duplicate listings of the same physical property. */
export function listingDuplicateSignature(listing) {
  const parts = [
    listing.organization_id,
    listing.offering_type,
    listing.property_type,
    listing.building_id ?? listing.community_id ?? '',
    (listing.unit_number ?? listing.reference_unit ?? '').toString().trim().toLowerCase(),
    listing.bedrooms ?? '',
    Math.round(Number(listing.built_up_area ?? 0)),
  ];
  return parts.join('|');
}
