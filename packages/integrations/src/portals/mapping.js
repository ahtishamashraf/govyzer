/**
 * Mapping engine shared by every portal adapter. Tenant defined mappings
 * (portal_field_mappings) always win over the built-in defaults so a portal can be
 * corrected without a code deployment.
 */
export function buildMappingIndex(mappings = []) {
  const index = new Map();
  for (const mapping of mappings) {
    const key = `${mapping.mapping_type}:${String(mapping.internal_value).toLowerCase()}`;
    index.set(key, mapping.provider_value);
  }
  return index;
}

export function mapValue(index, type, value, fallbackMap = {}, defaultValue = null) {
  if (value == null) return defaultValue;
  const key = `${type}:${String(value).toLowerCase()}`;
  if (index?.has(key)) return index.get(key);
  const fallback = fallbackMap[String(value).toLowerCase()];
  return fallback ?? defaultValue;
}

export const DEFAULT_PROPERTY_TYPE_MAP = Object.freeze({
  apartment: 'Apartment',
  villa: 'Villa',
  townhouse: 'Townhouse',
  penthouse: 'Penthouse',
  duplex: 'Duplex',
  land: 'Land',
  office: 'Office',
  retail: 'Retail',
  warehouse: 'Warehouse',
  labour_camp: 'Labour Camp',
  whole_building: 'Whole Building',
  hotel_apartment: 'Hotel Apartment',
});

export const DEFAULT_FURNISHING_MAP = Object.freeze({
  furnished: 'Yes',
  unfurnished: 'No',
  partly_furnished: 'Partly',
});

export const DEFAULT_RENT_FREQUENCY_MAP = Object.freeze({
  yearly: 'Yearly',
  monthly: 'Monthly',
  weekly: 'Weekly',
  daily: 'Daily',
});

/** Normalized, portal-neutral projection of a listing. Adapters map from this shape. */
export function toCanonicalListing(listing, context = {}) {
  return {
    reference: listing.reference,
    offering_type: listing.offering_type,
    property_type: listing.property_type,
    property_category: listing.property_category,
    title: { en: listing.title, ar: listing.title_ar ?? null },
    description: { en: listing.description, ar: listing.description_ar ?? null },
    price: listing.price == null ? null : Number(listing.price),
    currency: listing.currency,
    rent_frequency: listing.rent_frequency,
    service_charge: listing.service_charge == null ? null : Number(listing.service_charge),
    cheques_allowed: listing.cheques_allowed,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms == null ? null : Number(listing.bathrooms),
    size: listing.built_up_area == null ? null : Number(listing.built_up_area),
    plot_size: listing.plot_area == null ? null : Number(listing.plot_area),
    size_unit: listing.size_unit,
    parking_spaces: listing.parking_spaces,
    furnishing: listing.furnishing,
    view: listing.view,
    floor_number: listing.floor_number,
    completion_year: listing.completion_year,
    occupancy_status: listing.occupancy_status,
    available_from: listing.available_from,
    is_exclusive: Boolean(listing.is_exclusive),
    permit_number: listing.permit_number,
    permit_expires_on: listing.permit_expires_on,
    location: {
      city: context.city?.name ?? null,
      community: context.community?.name ?? null,
      subcommunity: context.subcommunity?.name ?? null,
      building: context.building?.name ?? null,
      latitude: listing.latitude == null ? null : Number(listing.latitude),
      longitude: listing.longitude == null ? null : Number(listing.longitude),
      hide_exact_address: Boolean(listing.hide_exact_address),
      portal_codes: {
        city: context.city?.portal_codes ?? null,
        community: context.community?.portal_codes ?? null,
        subcommunity: context.subcommunity?.portal_codes ?? null,
      },
    },
    amenities: context.amenities ?? [],
    media: (context.media ?? []).map((asset) => ({
      type: asset.asset_type,
      url: asset.public_url ?? asset.url ?? null,
      caption: asset.caption,
      position: asset.position,
      is_primary: Boolean(asset.is_primary),
    })),
    floor_plans: context.floorPlans ?? [],
    agent: context.agent
      ? {
          name: `${context.agent.first_name ?? ''} ${context.agent.last_name ?? ''}`.trim(),
          email: context.agent.email ?? null,
          phone: context.agent.phone ?? null,
          photo_url: context.agent.avatar_url ?? null,
          license_number: context.agent.license_number ?? null,
        }
      : null,
    updated_at: listing.updated_at,
  };
}

/** Shared UAE validation rules reused by the local portal adapters. */
export function validateUaeListing(canonical, { requirePermit = true, minImages = 1, maxImages = 30 } = {}) {
  const errors = [];
  const push = (code, field, message, severity = 'error') =>
    errors.push({ code, field, message, retryable: false, severity });

  if (!canonical.title?.en || canonical.title.en.trim().length < 10) {
    push('title_too_short', 'title', 'Title must be at least 10 characters');
  }
  if (!canonical.description?.en || canonical.description.en.trim().length < 50) {
    push('description_too_short', 'description', 'Description must be at least 50 characters');
  }
  if (canonical.price == null || canonical.price <= 0) {
    push('price_required', 'price', 'A price greater than zero is required');
  }
  if (canonical.offering_type === 'rent' && !canonical.rent_frequency) {
    push('rent_frequency_required', 'rent_frequency', 'Rental listings require a rent frequency');
  }
  if (canonical.size == null || canonical.size <= 0) {
    push('size_required', 'built_up_area', 'A built up area is required');
  }
  if (!canonical.location.community) {
    push('community_required', 'community_id', 'A community is required for UAE portals');
  }
  if (requirePermit && !canonical.permit_number) {
    push('permit_required', 'permit_number', 'A DLD/Trakheesi permit number is required to publish');
  }
  if (
    requirePermit &&
    canonical.permit_expires_on &&
    new Date(canonical.permit_expires_on) < new Date()
  ) {
    push('permit_expired', 'permit_expires_on', 'The listing permit has expired');
  }
  const images = canonical.media.filter((asset) => asset.type === 'image');
  if (images.length < minImages) {
    push('images_required', 'media', `At least ${minImages} image(s) are required`);
  }
  if (images.length > maxImages) {
    push('too_many_images', 'media', `At most ${maxImages} images are accepted`, 'warning');
  }
  if (!canonical.agent?.name) {
    push('agent_required', 'primary_agent_membership_id', 'A primary agent is required');
  }
  return errors;
}
