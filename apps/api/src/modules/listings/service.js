import { getDb, withTransaction } from '@govyzer/database';
import {
  newId,
  NotFoundError,
  ValidationError,
  ConflictError,
  listingStateMachine,
  listingDuplicateSignature,
} from '@govyzer/domain';
import { nextReference } from '../../core/references.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';
import { recordAudit } from '../../core/audit.js';
import { buildListingContext } from './canonical.js';
import { sha256 } from '../../core/crypto.js';

async function snapshotVersion({ trx, organizationId, listing, summary, actor }) {
  const [{ max_version: maxVersion }] = await trx('listing_versions')
    .where({ organization_id: organizationId, listing_id: listing.id })
    .max({ max_version: 'version_number' });
  await trx('listing_versions').insert({
    id: newId(),
    organization_id: organizationId,
    listing_id: listing.id,
    version_number: Number(maxVersion ?? 0) + 1,
    snapshot: JSON.stringify(listing),
    change_summary: summary,
    created_by_membership_id: actor?.membershipId ?? null,
  });
}

export async function createListing({ organizationId, actor, payload, request = {} }) {
  const db = getDb();

  const created = await withTransaction(db, async (trx) => {
    const reference = await nextReference({
      trx,
      organizationId,
      entity: 'listing',
      prefix: actor?.referencePrefix ?? 'GVZ',
    });
    const id = newId();
    const { amenity_codes: amenityCodes, version, ...rest } = payload;

    const signature = sha256(
      listingDuplicateSignature({
        organization_id: organizationId,
        offering_type: rest.offering_type,
        property_type: rest.property_type,
        building_id: rest.building_id,
        community_id: rest.community_id,
        unit_number: rest.unit_id ?? '',
        bedrooms: rest.bedrooms,
        built_up_area: rest.built_up_area,
      })
    );
    const duplicate = await trx('listings')
      .where({ organization_id: organizationId, duplicate_signature: signature })
      .whereNull('deleted_at')
      .whereNotIn('status', ['archived', 'withdrawn'])
      .first('id', 'reference');

    await trx('listings').insert({
      id,
      organization_id: organizationId,
      reference,
      ...rest,
      status: 'draft',
      duplicate_signature: signature,
      duplicate_of_listing_id: duplicate?.id ?? null,
      listing_admin_membership_id: actor?.membershipId ?? null,
      created_by: actor?.membershipId ?? null,
      updated_by: actor?.membershipId ?? null,
    });

    if (amenityCodes?.length)
      await setAmenities({ trx, organizationId, listingId: id, codes: amenityCodes });
    if (rest.primary_agent_membership_id) {
      await trx('listing_agents').insert({
        id: newId(),
        organization_id: organizationId,
        listing_id: id,
        membership_id: rest.primary_agent_membership_id,
        agent_role: 'primary',
        is_active: true,
      });
    }
    if (rest.permit_number) {
      await trx('listing_permits').insert({
        id: newId(),
        organization_id: organizationId,
        listing_id: id,
        authority: 'dld',
        permit_type: 'trakheesi',
        permit_number: rest.permit_number,
        issued_on: rest.permit_issued_on ?? null,
        expires_on: rest.permit_expires_on ?? null,
        status: 'active',
      });
    }

    const listing = await trx('listings').where('id', id).first();
    await snapshotVersion({ trx, organizationId, listing, summary: 'created', actor });
    await emitEvent(trx, {
      organizationId,
      eventType: EVENT_TYPES.LISTING_CREATED,
      aggregateType: 'listing',
      aggregateId: id,
      payload: { listing_id: id, reference, offering_type: listing.offering_type },
    });
    return { listing, duplicate_of: duplicate ?? null };
  });

  await recordAudit({
    organizationId,
    actor,
    action: 'listing.created',
    entityType: 'listing',
    entityId: created.listing.id,
    after: { reference: created.listing.reference },
    requestId: request.requestId,
  });
  return created;
}

export async function setAmenities({ trx, organizationId, listingId, codes }) {
  const db = trx ?? getDb();
  const amenities = await db('amenities')
    .whereIn('code', codes)
    .where((builder) =>
      builder.where('organization_id', organizationId).orWhere('organization_id', '')
    )
    .select('id', 'code');
  await db('entity_amenities').where({ entity_type: 'listing', entity_id: listingId }).delete();
  if (amenities.length > 0) {
    await db('entity_amenities').insert(
      amenities.map((amenity) => ({
        organization_id: organizationId,
        entity_type: 'listing',
        entity_id: listingId,
        amenity_id: amenity.id,
      }))
    );
  }
}

export async function updateListing({ organizationId, actor, id, payload, request = {} }) {
  const db = getDb();
  const before = await db('listings')
    .where({ id, organization_id: organizationId })
    .whereNull('deleted_at')
    .first();
  if (!before) throw new NotFoundError('Listing');

  const { amenity_codes: amenityCodes, version, ...rest } = payload;
  const updates = { ...rest, updated_by: actor.membershipId, updated_at: db.fn.now() };
  Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

  await withTransaction(db, async (trx) => {
    let query = trx('listings').where({ id, organization_id: organizationId });
    if (version != null) query = query.where('version', version);
    const updated = await query.update({ ...updates, version: trx.raw('`version` + 1') });
    if (updated === 0)
      throw new ConflictError('This listing was changed by someone else. Reload and try again.');

    if (amenityCodes)
      await setAmenities({ trx, organizationId, listingId: id, codes: amenityCodes });

    if (rest.price != null && Number(rest.price) !== Number(before.price ?? 0)) {
      await trx('listing_price_history').insert({
        id: newId(),
        organization_id: organizationId,
        listing_id: id,
        old_price: before.price,
        new_price: rest.price,
        currency: rest.currency ?? before.currency,
        rent_frequency: rest.rent_frequency ?? before.rent_frequency,
        reason: 'price updated',
        changed_by_membership_id: actor.membershipId,
      });
    }

    const listing = await trx('listings').where('id', id).first();
    await snapshotVersion({
      trx,
      organizationId,
      listing,
      summary: `updated: ${Object.keys(updates).join(', ')}`,
      actor,
    });

    // Published listings need to be re-synced whenever their content changes.
    if (['published', 'partially_published'].includes(before.status)) {
      await trx('portal_publications')
        .where({ organization_id: organizationId, listing_id: id })
        .whereIn('status', ['published'])
        .update({ status: 'queued', requested_at: trx.fn.now() });
    }
  });

  const after = await db('listings').where('id', id).first();
  await recordAudit({
    organizationId,
    actor,
    action: 'listing.updated',
    entityType: 'listing',
    entityId: id,
    before,
    after,
    requestId: request.requestId,
  });
  return after;
}

export async function changeStatus({ organizationId, actor, id, status, reason }) {
  const db = getDb();
  const listing = await db('listings')
    .where({ id, organization_id: organizationId })
    .whereNull('deleted_at')
    .first();
  if (!listing) throw new NotFoundError('Listing');
  listingStateMachine.assert(listing.status, status);

  await withTransaction(db, async (trx) => {
    await trx('listings')
      .where('id', id)
      .update({
        status,
        previous_status: listing.status,
        published_at: status === 'published' ? trx.fn.now() : listing.published_at,
        updated_by: actor.membershipId,
        updated_at: trx.fn.now(),
      });
    await trx('listing_availability_history').insert({
      id: newId(),
      organization_id: organizationId,
      listing_id: id,
      from_status: listing.status,
      to_status: status,
      reason: reason ?? null,
      changed_by_membership_id: actor.membershipId,
    });
    if (status === 'approved') {
      await emitEvent(trx, {
        organizationId,
        eventType: EVENT_TYPES.LISTING_APPROVED,
        aggregateType: 'listing',
        aggregateId: id,
        payload: { listing_id: id, reference: listing.reference },
      });
    }
    if (status === 'rejected') {
      await emitEvent(trx, {
        organizationId,
        eventType: EVENT_TYPES.LISTING_REJECTED,
        aggregateType: 'listing',
        aggregateId: id,
        payload: { listing_id: id, reason: reason ?? null },
      });
    }
  });

  await recordAudit({
    organizationId,
    actor,
    action: 'listing.status_changed',
    entityType: 'listing',
    entityId: id,
    before: { status: listing.status },
    after: { status, reason },
  });
  return db('listings').where('id', id).first();
}

export async function submitForApproval({ organizationId, actor, id }) {
  const db = getDb();
  const listing = await db('listings')
    .where({ id, organization_id: organizationId })
    .whereNull('deleted_at')
    .first();
  if (!listing) throw new NotFoundError('Listing');
  listingStateMachine.assert(listing.status, 'internal_review');

  await withTransaction(db, async (trx) => {
    await trx('listings')
      .where('id', id)
      .update({
        status: 'internal_review',
        updated_at: trx.fn.now(),
        updated_by: actor.membershipId,
      });
    await trx('listing_approvals').insert({
      id: newId(),
      organization_id: organizationId,
      listing_id: id,
      step: 'internal_review',
      status: 'pending',
      requested_by_membership_id: actor.membershipId,
    });
  });
  return db('listings').where('id', id).first();
}

export async function decideApproval({ organizationId, actor, id, decision, reason, checklist }) {
  const db = getDb();
  const listing = await db('listings')
    .where({ id, organization_id: organizationId })
    .whereNull('deleted_at')
    .first();
  if (!listing) throw new NotFoundError('Listing');

  const approval = await db('listing_approvals')
    .where({ organization_id: organizationId, listing_id: id, status: 'pending' })
    .orderBy('created_at', 'desc')
    .first();
  if (!approval) throw new ValidationError('This listing has no pending approval request');

  const nextStatus = decision === 'approved' ? 'approved' : 'rejected';
  listingStateMachine.assert(listing.status, nextStatus);

  await withTransaction(db, async (trx) => {
    await trx('listing_approvals')
      .where('id', approval.id)
      .update({
        status: decision,
        decided_by_membership_id: actor.membershipId,
        decided_at: trx.fn.now(),
        decision_reason: reason ?? null,
        checklist: checklist ? JSON.stringify(checklist) : null,
      });
    await trx('listings')
      .where('id', id)
      .update({ status: nextStatus, updated_at: trx.fn.now(), updated_by: actor.membershipId });
    await trx('listing_availability_history').insert({
      id: newId(),
      organization_id: organizationId,
      listing_id: id,
      from_status: listing.status,
      to_status: nextStatus,
      reason: reason ?? `approval ${decision}`,
      changed_by_membership_id: actor.membershipId,
    });
    await emitEvent(trx, {
      organizationId,
      eventType:
        decision === 'approved' ? EVENT_TYPES.LISTING_APPROVED : EVENT_TYPES.LISTING_REJECTED,
      aggregateType: 'listing',
      aggregateId: id,
      payload: {
        listing_id: id,
        reference: listing.reference,
        reason: reason ?? null,
        is_exclusive: Boolean(listing.is_exclusive),
      },
    });
  });

  await recordAudit({
    organizationId,
    actor,
    action: `listing.${decision}`,
    entityType: 'listing',
    entityId: id,
    before: { status: listing.status },
    after: { status: nextStatus, reason },
  });
  return db('listings').where('id', id).first();
}

export async function getListing({ organizationId, id }) {
  const db = getDb();
  const listing = await db('listings')
    .where({ id, organization_id: organizationId })
    .whereNull('deleted_at')
    .first();
  if (!listing) throw new NotFoundError('Listing');

  const [
    publications,
    media,
    agents,
    approvals,
    permits,
    priceHistory,
    availabilityHistory,
    amenities,
  ] = await Promise.all([
    db('portal_publications')
      .where({ organization_id: organizationId, listing_id: id })
      .whereNull('deleted_at'),
    db('media_assets')
      .where({ organization_id: organizationId, entity_type: 'listing', entity_id: id })
      .whereNull('deleted_at')
      .orderBy('position'),
    db('listing_agents as la')
      .leftJoin('organization_memberships as m', 'm.id', 'la.membership_id')
      .leftJoin('users as u', 'u.id', 'm.user_id')
      .where('la.listing_id', id)
      .select('la.*', 'u.first_name', 'u.last_name', 'u.email'),
    db('listing_approvals')
      .where({ organization_id: organizationId, listing_id: id })
      .orderBy('created_at', 'desc'),
    db('listing_permits')
      .where({ organization_id: organizationId, listing_id: id })
      .whereNull('deleted_at'),
    db('listing_price_history')
      .where({ organization_id: organizationId, listing_id: id })
      .orderBy('created_at', 'desc')
      .limit(50),
    db('listing_availability_history')
      .where({ organization_id: organizationId, listing_id: id })
      .orderBy('created_at', 'desc')
      .limit(50),
    db('entity_amenities')
      .join('amenities', 'amenities.id', 'entity_amenities.amenity_id')
      .where({ 'entity_amenities.entity_type': 'listing', 'entity_amenities.entity_id': id })
      .pluck('amenities.code'),
  ]);

  return {
    ...listing,
    publications: publications.map((publication) => ({
      ...publication,
      validation_errors:
        typeof publication.validation_errors === 'string'
          ? JSON.parse(publication.validation_errors ?? '[]')
          : publication.validation_errors,
    })),
    media,
    agents,
    approvals,
    permits,
    price_history: priceHistory,
    availability_history: availabilityHistory,
    amenity_codes: amenities,
  };
}

export async function buildCanonical({ organizationId, listingId }) {
  const db = getDb();
  const listing = await db('listings')
    .where({ id: listingId, organization_id: organizationId })
    .whereNull('deleted_at')
    .first();
  if (!listing) throw new NotFoundError('Listing');
  return buildListingContext({ organizationId, listing });
}
