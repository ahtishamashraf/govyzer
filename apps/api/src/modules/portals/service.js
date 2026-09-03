import { getDb, withTransaction } from '@govyzer/database';
import {
  newId,
  NotFoundError,
  ValidationError,
  ConflictError,
  publicationStateMachine,
} from '@govyzer/domain';
import { getPortalAdapter, listPortalAdapters } from '@govyzer/integrations';
import { encryptJson, decryptJson, randomToken, sha256 } from '../../core/crypto.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';
import { enqueueJob } from '../../core/jobs.js';
import { JOB_TYPES } from '../../jobs/index.js';
import { recordAudit } from '../../core/audit.js';
import { buildListingContext } from '../listings/canonical.js';
import { logger } from '../../core/logger.js';

const RAW_PAYLOAD_RETENTION_DAYS = 30;

/** Keeps the portal catalogue table in sync with the adapter registry. */
export async function syncProviderCatalogue(trx = getDb()) {
  for (const adapter of listPortalAdapters()) {
    const existing = await trx('portal_providers').where('code', adapter.code).first('id');
    const row = {
      name: adapter.name,
      transport: adapter.transport,
      capabilities: JSON.stringify(adapter.capabilities),
      is_active: true,
      updated_at: trx.fn.now(),
    };
    if (existing) await trx('portal_providers').where('id', existing.id).update(row);
    else await trx('portal_providers').insert({ id: newId(), code: adapter.code, country: 'AE', status: 'available', ...row });
  }
}

export async function listProviders() {
  const db = getDb();
  await syncProviderCatalogue(db);
  const rows = await db('portal_providers').where('is_active', true).orderBy('name');
  return rows.map((row) => ({
    ...row,
    capabilities: typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities,
  }));
}

async function storeCredentials({ trx, organizationId, connectionId, credentials }) {
  const encrypted = encryptJson(credentials);
  await trx('integration_credentials')
    .insert({
      id: newId(),
      organization_id: organizationId,
      connection_id: connectionId,
      credential_type: 'api_key',
      key_version: encrypted.key_version,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.auth_tag,
    })
    .onConflict(['connection_id', 'credential_type'])
    .merge({
      key_version: encrypted.key_version,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.auth_tag,
      rotated_at: trx.fn.now(),
    });
}

export async function loadCredentials({ organizationId, connectionId }) {
  const db = getDb();
  const record = await db('integration_credentials')
    .where({ organization_id: organizationId, connection_id: connectionId, credential_type: 'api_key' })
    .first();
  if (!record) return {};
  return decryptJson(record);
}

/**
 * Connects a portal account: validates the configuration through the adapter, encrypts the
 * credentials, records a capability snapshot and schedules the recurring sync jobs.
 */
export async function connectPortalAccount({ organizationId, actor, payload }) {
  const adapter = getPortalAdapter(payload.provider_code);
  if (!adapter) throw new ValidationError(`Unknown portal provider ${payload.provider_code}`);

  const validation = adapter.validateConfiguration(payload.credentials);
  if (!validation.valid) {
    throw new ValidationError('The portal configuration is not valid', validation.errors);
  }

  const db = getDb();
  const result = await withTransaction(db, async (trx) => {
    await syncProviderCatalogue(trx);
    const connectionId = newId();
    await trx('integration_connections').insert({
      id: connectionId,
      organization_id: organizationId,
      provider: adapter.code,
      category: 'portal',
      name: payload.name,
      status: 'connecting',
      is_enabled: payload.is_enabled,
      settings: JSON.stringify(payload.settings ?? {}),
      created_by: actor.membershipId,
    });
    await storeCredentials({ trx, organizationId, connectionId, credentials: validation.values });

    const accountId = newId();
    await trx('portal_accounts').insert({
      id: accountId,
      organization_id: organizationId,
      provider_code: adapter.code,
      name: payload.name,
      external_account_id: payload.external_account_id ?? null,
      status: 'connecting',
      integration_connection_id: connectionId,
      settings: JSON.stringify(payload.settings ?? {}),
      capabilities_snapshot: JSON.stringify(adapter.getCapabilities()),
      listing_quota: payload.listing_quota ?? null,
      auto_publish: payload.auto_publish,
      is_enabled: payload.is_enabled,
      feed_token: randomToken(24),
      created_by: actor.membershipId,
    });
    return { accountId, connectionId };
  });

  const health = await adapter.testConnection({ credentials: validation.values });
  await db('portal_accounts').where('id', result.accountId).update({
    status: health.ok ? 'connected' : 'error',
    health_status: health.ok ? 'healthy' : 'error',
    health_message: health.ok ? health.message ?? 'Connected' : JSON.stringify(health.errors ?? []).slice(0, 500),
    last_checked_at: db.fn.now(),
    last_success_at: health.ok ? db.fn.now() : null,
    updated_at: db.fn.now(),
  });
  await db('integration_connections').where('id', result.connectionId).update({
    status: health.ok ? 'connected' : 'error',
    health_status: health.ok ? 'healthy' : 'error',
    health_message: health.ok ? health.message ?? 'Connected' : 'Connection test failed',
    connected_at: health.ok ? db.fn.now() : null,
    last_checked_at: db.fn.now(),
    capabilities: JSON.stringify(adapter.getCapabilities()),
    updated_at: db.fn.now(),
  });

  if (health.ok && adapter.getCapabilities().statusPolling) {
    await enqueueJob({
      organizationId,
      jobType: JOB_TYPES.PORTAL_STATUS_REFRESH,
      payload: { portal_account_id: result.accountId },
      dedupeKey: `portal-status:${result.accountId}`,
      runAfter: new Date(Date.now() + 15 * 60 * 1000),
    });
  }

  await recordAudit({
    organizationId,
    actor,
    action: 'portal.connected',
    entityType: 'portal_account',
    entityId: result.accountId,
    after: { provider: adapter.code, name: payload.name, health: health.status },
  });

  return { account: await db('portal_accounts').where('id', result.accountId).first(), health };
}

export async function testPortalAccount({ organizationId, accountId }) {
  const db = getDb();
  const account = await db('portal_accounts').where({ id: accountId, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!account) throw new NotFoundError('Portal account');
  const adapter = getPortalAdapter(account.provider_code);
  const credentials = await loadCredentials({ organizationId, connectionId: account.integration_connection_id });
  const health = await adapter.testConnection({ credentials });

  await db('portal_accounts').where('id', account.id).update({
    health_status: health.ok ? 'healthy' : 'error',
    health_message: health.ok ? health.message ?? 'Connected' : JSON.stringify(health.errors ?? []).slice(0, 500),
    status: health.ok ? 'connected' : 'error',
    last_checked_at: db.fn.now(),
    last_success_at: health.ok ? db.fn.now() : account.last_success_at,
  });
  return health;
}

/** Validates a listing against each requested portal without publishing anything. */
export async function validateForPortals({ organizationId, listingId, portalAccountIds }) {
  const db = getDb();
  const listing = await db('listings').where({ id: listingId, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!listing) throw new NotFoundError('Listing');

  const context = await buildListingContext({ organizationId, listing });
  const accounts = await db('portal_accounts')
    .where('organization_id', organizationId)
    .whereIn('id', portalAccountIds)
    .whereNull('deleted_at');

  const results = [];
  for (const account of accounts) {
    const adapter = getPortalAdapter(account.provider_code);
    if (!adapter) {
      results.push({ portal_account_id: account.id, provider_code: account.provider_code, errors: [{ code: 'unknown_provider', message: 'This provider is no longer available', severity: 'error' }] });
      continue;
    }
    const mappings = await db('portal_field_mappings').where({ organization_id: organizationId, portal_account_id: account.id });
    const errors = adapter.validateListing(listing, { ...context, mappings });
    results.push({
      portal_account_id: account.id,
      provider_code: account.provider_code,
      name: account.name,
      valid: errors.filter((error) => error.severity === 'error').length === 0,
      errors,
    });
  }
  return { listing_id: listingId, results };
}

/** Creates or refreshes the publication rows and queues the actual portal calls. */
export async function publishListing({ organizationId, actor, listingId, portalAccountIds, validateOnly = false }) {
  const db = getDb();
  const listing = await db('listings').where({ id: listingId, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!listing) throw new NotFoundError('Listing');
  if (!['approved', 'published', 'partially_published', 'unpublished'].includes(listing.status)) {
    throw new ConflictError('Only an approved listing can be published to portals', { status: listing.status });
  }

  const validation = await validateForPortals({ organizationId, listingId, portalAccountIds });
  if (validateOnly) return { validation, queued: [] };

  const queued = [];
  await withTransaction(db, async (trx) => {
    for (const result of validation.results) {
      const existing = await trx('portal_publications')
        .where({ organization_id: organizationId, listing_id: listingId, portal_account_id: result.portal_account_id })
        .first();

      const status = result.valid ? 'queued' : 'failed';
      if (existing) {
        await trx('portal_publications').where('id', existing.id).update({
          status,
          provider_code: result.provider_code,
          validation_errors: JSON.stringify(result.errors),
          last_error_message: result.valid ? null : result.errors.find((error) => error.severity === 'error')?.message ?? null,
          requested_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        });
      } else {
        await trx('portal_publications').insert({
          id: newId(),
          organization_id: organizationId,
          listing_id: listingId,
          portal_account_id: result.portal_account_id,
          provider_code: result.provider_code,
          status,
          validation_errors: JSON.stringify(result.errors),
          last_error_message: result.valid ? null : result.errors.find((error) => error.severity === 'error')?.message ?? null,
          requested_at: trx.fn.now(),
        });
      }

      if (result.valid) {
        const publication = await trx('portal_publications')
          .where({ organization_id: organizationId, listing_id: listingId, portal_account_id: result.portal_account_id })
          .first('id');
        queued.push(publication.id);
        await enqueueJob({
          organizationId,
          jobType: JOB_TYPES.PORTAL_PUBLISH,
          payload: { publication_id: publication.id },
          dedupeKey: `portal-publish:${publication.id}:${listing.version}`,
          trx,
        });
      }
    }

    await trx('listings').where('id', listingId).update({ status: 'publishing', updated_at: trx.fn.now(), updated_by: actor?.membershipId ?? null });
  });

  await recordAudit({
    organizationId,
    actor,
    action: 'listing.publish_requested',
    entityType: 'listing',
    entityId: listingId,
    after: { portal_account_ids: portalAccountIds, queued: queued.length },
  });
  return { validation, queued };
}

/** Runs one publication against its portal. Called by the job runner. */
export async function executePublication({ db = getDb(), publicationId }) {
  const publication = await db('portal_publications').where('id', publicationId).first();
  if (!publication) return { skipped: true, reason: 'publication_missing' };

  const organizationId = publication.organization_id;
  const account = await db('portal_accounts').where('id', publication.portal_account_id).first();
  const listing = await db('listings').where('id', publication.listing_id).first();
  const adapter = getPortalAdapter(publication.provider_code);
  if (!account || !listing || !adapter) return { skipped: true, reason: 'missing_dependencies' };

  publicationStateMachine.assert(publication.status, 'publishing');
  await db('portal_publications').where('id', publicationId).update({ status: 'publishing', attempts: Number(publication.attempts ?? 0) + 1 });

  const context = await buildListingContext({ organizationId, listing });
  const mappings = await db('portal_field_mappings').where({ organization_id: organizationId, portal_account_id: account.id });
  const credentials = await loadCredentials({ organizationId, connectionId: account.integration_connection_id });

  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await adapter.publishListing({ listing, credentials, context: { ...context, mappings } });
  } catch (error) {
    outcome = { ok: false, status: 'failed', errors: [adapter.normalizeProviderError(error)] };
  }

  const durationMs = Date.now() - startedAt;
  const succeeded = outcome.ok === true;

  await db('portal_publications')
    .where('id', publicationId)
    .update({
      status: succeeded ? 'published' : outcome.status === 'validation_failed' ? 'failed' : outcome.status === 'rejected' ? 'rejected' : 'failed',
      external_listing_id: outcome.externalId ?? publication.external_listing_id,
      external_url: outcome.externalUrl ?? publication.external_url,
      published_at: succeeded ? db.fn.now() : publication.published_at,
      last_synced_at: db.fn.now(),
      last_error_code: succeeded ? null : outcome.errors?.[0]?.code ?? 'unknown_error',
      last_error_message: succeeded ? null : outcome.errors?.[0]?.message ?? 'Publication failed',
      validation_errors: JSON.stringify(outcome.errors ?? []),
      provider_payload_snapshot: outcome.payload ? JSON.stringify(outcome.payload) : null,
      content_hash: sha256(JSON.stringify(context.canonical)),
      updated_at: db.fn.now(),
    });

  await db('portal_sync_logs').insert({
    id: newId(),
    organization_id: organizationId,
    portal_account_id: account.id,
    publication_id: publicationId,
    operation: 'publish',
    result: succeeded ? 'success' : 'failure',
    provider_correlation_id: outcome.correlationId ?? null,
    duration_ms: durationMs,
    message: succeeded ? outcome.status : outcome.errors?.[0]?.message ?? 'failed',
    normalized_errors: JSON.stringify(outcome.errors ?? []),
  });

  await db('portal_raw_payloads').insert({
    id: newId(),
    organization_id: organizationId,
    portal_account_id: account.id,
    provider_code: account.provider_code,
    direction: 'outbound',
    operation: 'publish',
    reference_type: 'listing',
    reference_id: listing.id,
    body: JSON.stringify(outcome.payload ?? {}).slice(0, 500_000),
    content_type: 'application/json',
    expires_at: new Date(Date.now() + RAW_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  });

  await refreshListingAggregateStatus({ db, organizationId, listingId: listing.id });

  if (!succeeded) {
    await emitEvent(db, {
      organizationId,
      eventType: EVENT_TYPES.PORTAL_ERROR,
      aggregateType: 'portal_publication',
      aggregateId: publicationId,
      payload: { listing_id: listing.id, provider: account.provider_code, errors: outcome.errors ?? [] },
    });
    await db('portal_accounts')
      .where('id', account.id)
      .update({ health_status: 'degraded', health_message: outcome.errors?.[0]?.message ?? 'Publication failed', last_checked_at: db.fn.now() });
    logger.warn('portal_publish_failed', { publication_id: publicationId, provider: account.provider_code });
  } else {
    await db('portal_accounts').where('id', account.id).update({ health_status: 'healthy', last_success_at: db.fn.now(), last_checked_at: db.fn.now() });
  }
  return outcome;
}

/** Recomputes the listing status from the state of its publications. */
export async function refreshListingAggregateStatus({ db = getDb(), organizationId, listingId }) {
  const publications = await db('portal_publications')
    .where({ organization_id: organizationId, listing_id: listingId })
    .whereNull('deleted_at');
  if (publications.length === 0) return null;

  const published = publications.filter((publication) => publication.status === 'published').length;
  const listing = await db('listings').where('id', listingId).first();
  let status = listing.status;

  if (published === 0) status = publications.some((publication) => ['failed', 'rejected'].includes(publication.status)) ? 'approved' : listing.status;
  else if (published === publications.length) status = 'published';
  else status = 'partially_published';

  if (status !== listing.status) {
    await db('listings').where('id', listingId).update({
      status,
      published_at: status === 'published' ? db.fn.now() : listing.published_at,
      last_portal_sync_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    await db('listing_availability_history').insert({
      id: newId(),
      organization_id: organizationId,
      listing_id: listingId,
      from_status: listing.status,
      to_status: status,
      reason: 'portal publication status changed',
    });
    if (status === 'published') {
      await emitEvent(db, {
        organizationId,
        eventType: EVENT_TYPES.LISTING_PUBLISHED,
        aggregateType: 'listing',
        aggregateId: listingId,
        payload: {
          listing_id: listingId,
          reference: listing.reference,
          title: listing.title,
          offering_type: listing.offering_type,
          property_type: listing.property_type,
          price: listing.price,
          currency: listing.currency,
          is_exclusive: Boolean(listing.is_exclusive),
          agent_membership_id: listing.primary_agent_membership_id,
          community_id: listing.community_id,
        },
      });
    }
  }
  return status;
}

export async function unpublishListing({ organizationId, actor, listingId, portalAccountIds = null }) {
  const db = getDb();
  let query = db('portal_publications').where({ organization_id: organizationId, listing_id: listingId }).whereNull('deleted_at');
  if (portalAccountIds) query = query.whereIn('portal_account_id', portalAccountIds);
  const publications = await query;

  for (const publication of publications) {
    await db('portal_publications').where('id', publication.id).update({ status: 'unpublishing', updated_at: db.fn.now() });
    await enqueueJob({
      organizationId,
      jobType: JOB_TYPES.PORTAL_UNPUBLISH,
      payload: { publication_id: publication.id },
      dedupeKey: `portal-unpublish:${publication.id}`,
    });
  }
  await recordAudit({ organizationId, actor, action: 'listing.unpublish_requested', entityType: 'listing', entityId: listingId, after: { publications: publications.length } });
  return { queued: publications.length };
}

export async function executeUnpublish({ db = getDb(), publicationId }) {
  const publication = await db('portal_publications').where('id', publicationId).first();
  if (!publication) return { skipped: true };
  const account = await db('portal_accounts').where('id', publication.portal_account_id).first();
  const adapter = getPortalAdapter(publication.provider_code);
  const credentials = await loadCredentials({ organizationId: publication.organization_id, connectionId: account.integration_connection_id });

  const outcome = await adapter.unpublishListing({ credentials, externalId: publication.external_listing_id ?? publication.listing_id });
  await db('portal_publications').where('id', publicationId).update({
    status: outcome.ok ? 'unpublished' : 'failed',
    unpublished_at: outcome.ok ? db.fn.now() : null,
    last_error_message: outcome.ok ? null : outcome.errors?.[0]?.message ?? 'Unpublish failed',
    updated_at: db.fn.now(),
  });
  await db('portal_sync_logs').insert({
    id: newId(),
    organization_id: publication.organization_id,
    portal_account_id: account.id,
    publication_id: publicationId,
    operation: 'unpublish',
    result: outcome.ok ? 'success' : 'failure',
    message: outcome.status,
    normalized_errors: JSON.stringify(outcome.errors ?? []),
  });
  await refreshListingAggregateStatus({ db, organizationId: publication.organization_id, listingId: publication.listing_id });
  return outcome;
}

/** Generates the public feed a portal pulls. Authorized by the account's feed token. */
export async function buildFeed({ providerCode, feedToken, format = 'xml' }) {
  const db = getDb();
  const account = await db('portal_accounts')
    .where({ provider_code: providerCode, feed_token: feedToken })
    .whereNull('deleted_at')
    .first();
  if (!account) throw new NotFoundError('Feed');

  const adapter = getPortalAdapter(providerCode);
  const organizationId = account.organization_id;
  const listings = await db('listings')
    .where('organization_id', organizationId)
    .whereNull('deleted_at')
    .whereIn('status', ['approved', 'published', 'partially_published', 'publishing'])
    .orderBy('updated_at', 'desc')
    .limit(2000);

  const canonicalListings = [];
  for (const listing of listings) {
    const context = await buildListingContext({ organizationId, listing });
    canonicalListings.push(context.canonical);
  }

  await db('portal_accounts').where('id', account.id).update({ last_success_at: db.fn.now(), last_checked_at: db.fn.now() });

  if (typeof adapter?.buildFeed === 'function') {
    const body = adapter.buildFeed(canonicalListings);
    return {
      contentType: typeof body === 'string' ? 'application/xml' : 'application/json',
      body,
      count: canonicalListings.length,
    };
  }
  return { contentType: 'application/json', body: { generated_at: new Date().toISOString(), listings: canonicalListings }, count: canonicalListings.length };
}
