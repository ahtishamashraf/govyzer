/** Minimal, dependency free XML writer. All values are escaped. */
export function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function xmlTag(name, value, attributes = {}) {
  const attrs = Object.entries(attributes)
    .map(([key, val]) => ` ${key}="${escapeXml(val)}"`)
    .join('');
  if (value === null || value === undefined || value === '') return `<${name}${attrs}/>`;
  return `<${name}${attrs}>${escapeXml(value)}</${name}>`;
}

/**
 * Builds the Govyzer standard property feed. Portal specific feeds reuse this builder
 * with their own element names supplied through `fieldMap`.
 */
export function buildListingFeedXml(listings, { root = 'listings', item = 'listing', fieldMap = null, generatedAt = new Date() } = {}) {
  const map =
    fieldMap ??
    ((canonical) => ({
      reference: canonical.reference,
      offering_type: canonical.offering_type,
      property_type: canonical.property_type,
      title_en: canonical.title.en,
      title_ar: canonical.title.ar,
      description_en: canonical.description.en,
      description_ar: canonical.description.ar,
      price: canonical.price,
      currency: canonical.currency,
      rent_frequency: canonical.rent_frequency,
      bedrooms: canonical.bedrooms,
      bathrooms: canonical.bathrooms,
      size: canonical.size,
      size_unit: canonical.size_unit,
      parking: canonical.parking_spaces,
      furnished: canonical.furnishing,
      city: canonical.location.city,
      community: canonical.location.community,
      subcommunity: canonical.location.subcommunity,
      building: canonical.location.building,
      latitude: canonical.location.hide_exact_address ? null : canonical.location.latitude,
      longitude: canonical.location.hide_exact_address ? null : canonical.location.longitude,
      permit_number: canonical.permit_number,
      agent_name: canonical.agent?.name ?? null,
      agent_email: canonical.agent?.email ?? null,
      agent_phone: canonical.agent?.phone ?? null,
      last_updated: canonical.updated_at,
    }));

  const body = listings
    .map((canonical) => {
      const fields = map(canonical);
      const scalars = Object.entries(fields)
        .map(([key, value]) => xmlTag(key, value))
        .join('');
      const photos = canonical.media
        .filter((asset) => asset.type === 'image' && asset.url)
        .sort((a, b) => a.position - b.position)
        .map((asset) => xmlTag('photo', asset.url, { primary: asset.is_primary ? 'true' : 'false' }))
        .join('');
      const amenities = (canonical.amenities ?? []).map((code) => xmlTag('amenity', code)).join('');
      return `<${item}>${scalars}<photos>${photos}</photos><amenities>${amenities}</amenities></${item}>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?><${root} generated_at="${escapeXml(
    generatedAt.toISOString()
  )}" count="${listings.length}">${body}</${root}>`;
}

export function buildListingFeedJson(listings, { generatedAt = new Date() } = {}) {
  return {
    generated_at: generatedAt.toISOString(),
    count: listings.length,
    listings,
  };
}
