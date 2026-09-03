import { getDb } from '@govyzer/database';
import { newId } from '@govyzer/domain';

/** Domain events emitted by the application. Webhooks and Sales Screen both consume these. */
export const EVENT_TYPES = Object.freeze({
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_STAGE_CHANGED: 'lead.stage_changed',
  LEAD_SLA_BREACHED: 'lead.sla_breached',
  CONTACT_CREATED: 'contact.created',
  LISTING_CREATED: 'listing.created',
  LISTING_APPROVED: 'listing.approved',
  LISTING_PUBLISHED: 'listing.published',
  LISTING_REJECTED: 'listing.rejected',
  PORTAL_ERROR: 'portal.error',
  MEETING_CREATED: 'meeting.created',
  VIEWING_COMPLETED: 'viewing.completed',
  RESERVATION_CREATED: 'reservation.created',
  RESERVATION_EXPIRED: 'reservation.expired',
  BOOKING_CREATED: 'booking.created',
  DEAL_CREATED: 'deal.created',
  DEAL_UPDATED: 'deal.updated',
  DEAL_WON: 'deal.won',
  DEAL_LOST: 'deal.lost',
  DEAL_CANCELLED: 'deal.cancelled',
  DOCUMENT_GENERATED: 'document.generated',
  MESSAGE_RECEIVED: 'message.received',
});

/**
 * Writes an outbox row inside the caller's transaction so an event can never be published
 * for a change that rolled back, and never lost for one that committed.
 */
export async function emitEvent(trx, { organizationId, eventType, aggregateType, aggregateId, payload = {}, metadata = {}, availableAt = null }) {
  const db = trx ?? getDb();
  const id = newId();
  await db('outbox_events').insert({
    id,
    organization_id: organizationId,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    payload: JSON.stringify(payload),
    metadata: JSON.stringify(metadata),
    status: 'pending',
    available_at: availableAt ?? db.fn.now(),
  });
  return id;
}

/** Claims a bounded batch of pending events with a short lease, safe to run concurrently. */
export async function claimEvents(db, { limit = 50, workerId, leaseSeconds = 60 } = {}) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);

  const candidates = await db('outbox_events')
    .where('status', 'pending')
    .where('available_at', '<=', now)
    .where((builder) => builder.whereNull('locked_until').orWhere('locked_until', '<', now))
    .orderBy('created_at', 'asc')
    .limit(limit)
    .pluck('id');

  if (candidates.length === 0) return [];

  const claimed = await db('outbox_events')
    .whereIn('id', candidates)
    .where((builder) => builder.whereNull('locked_until').orWhere('locked_until', '<', now))
    .update({ locked_by: workerId, locked_until: leaseUntil, status: 'processing' });

  if (claimed === 0) return [];
  return db('outbox_events').whereIn('id', candidates).where('locked_by', workerId);
}

export async function completeEvent(db, id) {
  await db('outbox_events')
    .where('id', id)
    .update({ status: 'processed', processed_at: db.fn.now(), locked_by: null, locked_until: null });
}

export async function failEvent(db, id, error, { maxAttempts = 6 } = {}) {
  const row = await db('outbox_events').where('id', id).first();
  const attempts = Number(row?.attempts ?? 0) + 1;
  const exhausted = attempts >= maxAttempts;
  const backoffMs = Math.min(2 ** attempts * 1000, 15 * 60 * 1000);
  await db('outbox_events')
    .where('id', id)
    .update({
      status: exhausted ? 'dead' : 'pending',
      attempts,
      last_error: String(error?.message ?? error).slice(0, 1000),
      available_at: new Date(Date.now() + backoffMs),
      locked_by: null,
      locked_until: null,
    });
  if (exhausted) {
    await db('dead_letter_jobs').insert({
      id: newId(),
      organization_id: row?.organization_id ?? '',
      origin: 'outbox',
      origin_id: id,
      job_type: row?.event_type ?? 'outbox_event',
      payload: row?.payload ?? '{}',
      attempts,
      last_error: String(error?.message ?? error).slice(0, 2000),
      status: 'open',
    });
  }
}
