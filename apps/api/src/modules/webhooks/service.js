import { getDb } from '@govyzer/database';
import { newId } from '@govyzer/domain';
import { getIntegrationAdapter, getPortalAdapter } from '@govyzer/integrations';
import { sha256, decryptSecret } from '../../core/crypto.js';
import { enqueueJob } from '../../core/jobs.js';
import { JOB_TYPES } from '../../jobs/index.js';
import { logger } from '../../core/logger.js';
import { createLead } from '../leads/service.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';

/**
 * Stores an inbound webhook and queues it for processing. Acknowledging quickly is the
 * point: nothing heavier than an insert happens on the request path.
 */
export async function receiveWebhook({ provider, headers, rawBody, organizationId = '', externalEventId = null, signatureStatus = 'unverified', requestId = null }) {
  const db = getDb();
  const idempotencyKey = externalEventId ?? sha256(rawBody ?? '').slice(0, 60);

  const existing = await db('webhook_receipts').where({ provider, idempotency_key: idempotencyKey }).first();
  if (existing) return { receipt_id: existing.id, duplicate: true };

  const id = newId();
  await db('webhook_receipts').insert({
    id,
    organization_id: organizationId,
    provider,
    external_event_id: externalEventId,
    idempotency_key: idempotencyKey,
    signature_status: signatureStatus,
    headers: JSON.stringify(headers ?? {}),
    body: rawBody ?? null,
    status: 'received',
    request_id: requestId,
  });

  await enqueueJob({
    organizationId,
    jobType: JOB_TYPES.WEBHOOK_PROCESS,
    payload: { receipt_id: id },
    dedupeKey: `webhook:${id}`,
  });
  return { receipt_id: id, duplicate: false };
}

/** Normalizes a stored webhook into CRM records. Safe to re-run. */
export async function processWebhookReceipt({ db = getDb(), receiptId }) {
  const receipt = await db('webhook_receipts').where('id', receiptId).first();
  if (!receipt || receipt.status === 'processed') return { skipped: true };

  await db('webhook_receipts').where('id', receiptId).update({ status: 'processing', attempts: Number(receipt.attempts ?? 0) + 1 });

  try {
    const payload = receipt.body ? JSON.parse(receipt.body) : {};
    const organizationId = receipt.organization_id;
    const portalAdapter = getPortalAdapter(receipt.provider);
    const messagingAdapter = getIntegrationAdapter(receipt.provider);

    if (portalAdapter && organizationId) {
      const normalized = portalAdapter.normalizeLead(payload, {});
      await ingestNormalizedLead({ db, organizationId, normalized, provider: receipt.provider });
    } else if (messagingAdapter?.normalizeInbound && organizationId) {
      const messages = messagingAdapter.normalizeInbound(payload);
      const list = Array.isArray(messages) ? messages : [messages];
      for (const message of list) await ingestMessage({ db, organizationId, message });
    } else {
      logger.warn('webhook_no_adapter', { provider: receipt.provider, receipt_id: receiptId });
    }

    await db('webhook_receipts').where('id', receiptId).update({ status: 'processed', processed_at: db.fn.now(), last_error: null });
    return { processed: true };
  } catch (error) {
    await db('webhook_receipts').where('id', receiptId).update({ status: 'failed', last_error: String(error.message).slice(0, 1000) });
    throw error;
  }
}

/** Turns a normalized provider lead into a contact + lead, idempotently. */
export async function ingestNormalizedLead({ db = getDb(), organizationId, normalized, provider, campaignId = null }) {
  const idempotencyKey = normalized.external_id ? `${provider}:${normalized.external_id}` : sha256(JSON.stringify(normalized)).slice(0, 60);
  const existing = await db('external_lead_receipts').where({ organization_id: organizationId, provider, idempotency_key: idempotencyKey }).first();
  if (existing?.lead_id) return { lead_id: existing.lead_id, duplicate: true };

  const receiptId = existing?.id ?? newId();
  if (!existing) {
    await db('external_lead_receipts').insert({
      id: receiptId,
      organization_id: organizationId,
      provider,
      external_id: normalized.external_id ?? '',
      idempotency_key: idempotencyKey,
      status: 'processing',
      raw_payload: JSON.stringify(normalized.raw ?? {}),
      normalized_payload: JSON.stringify({ ...normalized, raw: undefined }),
    });
  }

  try {
    let listing = null;
    if (normalized.property_reference) {
      listing = await db('listings')
        .where({ organization_id: organizationId, reference: normalized.property_reference })
        .whereNull('deleted_at')
        .first('id', 'primary_agent_membership_id');
    }

    const identifiers = [];
    if (normalized.phone) identifiers.push({ identifier_type: 'phone', value: normalized.phone, is_primary: true });
    if (normalized.email) identifiers.push({ identifier_type: 'email', value: normalized.email });

    const [firstName, ...rest] = String(normalized.name ?? '').trim().split(' ');
    const result = await createLead({
      organizationId,
      actor: { membershipId: null, referencePrefix: (await db('organizations').where('id', organizationId).first('reference_prefix'))?.reference_prefix ?? 'GVZ' },
      payload: {
        module: normalized.module ?? 'ready',
        purpose: normalized.purpose ?? 'buy',
        source_code: normalized.source ?? provider,
        portal_code: normalized.portal_code ?? provider,
        external_lead_id: normalized.external_id ?? null,
        listing_id: listing?.id ?? null,
        property_reference: normalized.property_reference ?? null,
        language: normalized.language ?? 'en',
        notes: normalized.message ?? null,
        utm: normalized.utm ?? null,
        campaign_id: campaignId,
        estimated_value: normalized.budget_max ?? null,
        provider_payload: normalized.raw ?? null,
        contact: {
          first_name: firstName || null,
          last_name: rest.join(' ') || null,
          display_name: normalized.name ?? null,
          identifiers,
        },
        requirements: normalized.budget_max || normalized.bedrooms ? [{ budget_min: normalized.budget_min ?? null, budget_max: normalized.budget_max ?? null, bedrooms_min: normalized.bedrooms ?? null }] : [],
        auto_assign: true,
      },
      source: provider,
    });

    await db('external_lead_receipts').where('id', receiptId).update({
      status: 'processed',
      lead_id: result.lead.id,
      contact_id: result.contact.id,
      processed_at: db.fn.now(),
    });
    return { lead_id: result.lead.id, contact_id: result.contact.id, duplicate: false };
  } catch (error) {
    await db('external_lead_receipts').where('id', receiptId).update({
      status: 'failed',
      error_message: String(error.message).slice(0, 500),
      attempts: db.raw('attempts + 1'),
    });
    throw error;
  }
}

/** Stores a normalized message on the right thread and links it to a contact/lead. */
export async function ingestMessage({ db = getDb(), organizationId, message }) {
  const existing = await db('messages')
    .where({ organization_id: organizationId, provider: message.provider, external_message_id: message.external_message_id })
    .first('id');
  if (existing) return { message_id: existing.id, duplicate: true };

  const externalIdentity = message.direction === 'inbound' ? message.from_identifier : message.to_identifier;
  const normalizedIdentity = externalIdentity ? String(externalIdentity).replace(/[^\d+@.a-zA-Z]/g, '') : null;

  let contactId = null;
  let leadId = null;
  if (normalizedIdentity) {
    const identifier = await db('contact_identifiers')
      .where('organization_id', organizationId)
      .where((builder) => builder.where('value_normalized', normalizedIdentity).orWhere('value_normalized', `+${normalizedIdentity.replace(/^\+/, '')}`))
      .first('contact_id');
    contactId = identifier?.contact_id ?? null;
    if (contactId) {
      const lead = await db('leads')
        .where({ organization_id: organizationId, contact_id: contactId, status: 'open' })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .first('id');
      leadId = lead?.id ?? null;
    }
  }

  let thread = await db('communication_threads')
    .where({ organization_id: organizationId, provider: message.provider, external_thread_id: message.external_thread_id })
    .first();
  if (!thread) {
    const threadId = newId();
    await db('communication_threads').insert({
      id: threadId,
      organization_id: organizationId,
      channel: message.channel,
      provider: message.provider,
      external_thread_id: message.external_thread_id,
      contact_id: contactId,
      lead_id: leadId,
      status: 'open',
      last_message_at: message.sent_at ?? db.fn.now(),
    });
    thread = await db('communication_threads').where('id', threadId).first();
  }

  const id = newId();
  await db('messages').insert({
    id,
    organization_id: organizationId,
    thread_id: thread.id,
    channel: message.channel,
    provider: message.provider,
    external_message_id: message.external_message_id,
    direction: message.direction,
    from_identifier: message.from_identifier,
    to_identifier: message.to_identifier,
    contact_id: contactId ?? thread.contact_id,
    lead_id: leadId ?? thread.lead_id,
    message_type: message.message_type,
    body: message.body,
    attachments: JSON.stringify(message.attachments ?? []),
    status: message.status,
    sent_at: message.sent_at,
    delivered_at: message.delivered_at,
    read_at: message.read_at,
    provider_metadata: JSON.stringify(message.provider_metadata ?? {}),
  });

  await db('communication_threads').where('id', thread.id).update({
    last_message_at: message.sent_at ?? db.fn.now(),
    contact_id: thread.contact_id ?? contactId,
    lead_id: thread.lead_id ?? leadId,
    unread_count: message.direction === 'inbound' ? Number(thread.unread_count ?? 0) + 1 : thread.unread_count,
    updated_at: db.fn.now(),
  });

  if (leadId) await db('leads').where('id', leadId).update({ last_activity_at: db.fn.now() });
  await emitEvent(db, {
    organizationId,
    eventType: EVENT_TYPES.MESSAGE_RECEIVED,
    aggregateType: 'message',
    aggregateId: id,
    payload: { message_id: id, channel: message.channel, direction: message.direction, contact_id: contactId, lead_id: leadId },
  });
  return { message_id: id, duplicate: false };
}

export async function loadConnectionCredentials({ db = getDb(), connectionId }) {
  const record = await db('integration_credentials').where({ connection_id: connectionId, credential_type: 'api_key' }).first();
  if (!record) return {};
  return JSON.parse(decryptSecret(record));
}
