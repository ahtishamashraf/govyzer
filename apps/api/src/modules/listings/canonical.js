import { getDb } from '@govyzer/database';
import { toCanonicalListing } from '@govyzer/integrations';
import { createDownloadUrl, isStorageConfigured } from '../../core/storage.js';

/** Builds the portal-neutral projection of a listing, including signed media URLs. */
export async function buildListingContext({ organizationId, listing, includeSignedMedia = true }) {
  const db = getDb();

  const [community, subcommunity, city, building, amenities, media, floorPlans, agent] = await Promise.all([
    listing.community_id ? db('communities').where('id', listing.community_id).first() : null,
    listing.subcommunity_id ? db('subcommunities').where('id', listing.subcommunity_id).first() : null,
    listing.city_id ? db('cities').where('id', listing.city_id).first() : null,
    listing.building_id ? db('buildings').where('id', listing.building_id).first() : null,
    db('entity_amenities')
      .join('amenities', 'amenities.id', 'entity_amenities.amenity_id')
      .where('entity_amenities.entity_type', 'listing')
      .where('entity_amenities.entity_id', listing.id)
      .select('amenities.code', 'amenities.name', 'amenities.portal_codes'),
    db('media_assets')
      .where({ organization_id: organizationId, entity_type: 'listing', entity_id: listing.id })
      .whereNull('deleted_at')
      .orderBy('position'),
    db('floor_plans')
      .where({ organization_id: organizationId, entity_type: 'listing', entity_id: listing.id })
      .whereNull('deleted_at')
      .orderBy('position'),
    listing.primary_agent_membership_id
      ? db('organization_memberships as m')
          .join('users as u', 'u.id', 'm.user_id')
          .where('m.id', listing.primary_agent_membership_id)
          .first('m.id', 'u.first_name', 'u.last_name', 'u.email', 'u.phone', 'u.avatar_url', 'm.employee_code as license_number')
      : null,
  ]);

  const mediaWithUrls = [];
  for (const asset of media) {
    const url = includeSignedMedia && isStorageConfigured() ? await createDownloadUrl(asset.storage_key, { expiresIn: 3600 }) : null;
    mediaWithUrls.push({ ...asset, public_url: url });
  }

  const context = {
    community,
    subcommunity,
    city,
    building,
    amenities: amenities.map((amenity) => amenity.code),
    amenityRecords: amenities,
    media: mediaWithUrls,
    floorPlans: floorPlans.map((plan) => ({ ...plan, url: null })),
    agent,
  };
  return { ...context, canonical: toCanonicalListing(listing, context) };
}
