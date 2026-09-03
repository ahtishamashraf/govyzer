import { getDb } from '@govyzer/database';
import { newId } from '@govyzer/domain';
import { claimEvents, completeEvent, failEvent, EVENT_TYPES } from '../core/outbox.js';
import { createSalesEvent, awardPoints, reversePointsFor } from '../modules/sales-screen/service.js';
import { dispatchTrigger } from '../modules/workflows/engine.js';
import { logger } from '../core/logger.js';

const WORKFLOW_TRIGGER_BY_EVENT = {
  [EVENT_TYPES.LEAD_CREATED]: { trigger: 'record_created', entityType: 'lead' },
  [EVENT_TYPES.LEAD_UPDATED]: { trigger: 'record_updated', entityType: 'lead' },
  [EVENT_TYPES.LEAD_STAGE_CHANGED]: { trigger: 'stage_changed', entityType: 'lead' },
  [EVENT_TYPES.LEAD_ASSIGNED]: { trigger: 'assignment_changed', entityType: 'lead' },
  [EVENT_TYPES.LEAD_SLA_BREACHED]: { trigger: 'sla_breached', entityType: 'lead' },
  [EVENT_TYPES.MEETING_CREATED]: { trigger: 'record_created', entityType: 'meeting' },
  [EVENT_TYPES.LISTING_REJECTED]: { trigger: 'listing_rejected', entityType: 'listing' },
  [EVENT_TYPES.PORTAL_ERROR]: { trigger: 'portal_error', entityType: 'listing' },
  [EVENT_TYPES.DEAL_WON]: { trigger: 'deal_won', entityType: 'deal' },
  [EVENT_TYPES.DEAL_LOST]: { trigger: 'deal_lost', entityType: 'deal' },
  [EVENT_TYPES.RESERVATION_EXPIRED]: { trigger: 'reservation_expiring', entityType: 'reservation' },
};

/** Fans one domain event out to Sales Screen, points, workflows and webhooks. */
export async function handleOutboxEvent({ db, event }) {
  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload ?? {};
  const organizationId = event.organization_id;

  switch (event.event_type) {
    case EVENT_TYPES.DEAL_WON: {
      if (payload.is_sales_screen_eligible !== false) {
        await createSalesEvent({
          db,
          organizationId,
          eventType: 'deal_won',
          sourceEntityType: 'deal',
          sourceEntityId: payload.deal_id,
          idempotencyKey: `deal_won:${payload.deal_id}`,
          amount: payload.property_value ?? null,
          currency: payload.currency ?? 'AED',
          membershipId: payload.agent_membership_id ?? null,
          teamId: payload.team_id ?? null,
          branchId: payload.branch_id ?? null,
          projectId: payload.project_id ?? null,
          displayPayload: {
            headline: 'Deal closed',
            reference: payload.reference,
            deal_type: payload.deal_type,
            module: payload.module,
            agent_name: payload.agent_name ?? null,
            property_value: payload.property_value ?? null,
            currency: payload.currency ?? 'AED',
          },
          occurredAt: payload.won_at ? new Date(payload.won_at) : new Date(),
        });
      }
      break;
    }

    case EVENT_TYPES.LISTING_PUBLISHED: {
      await createSalesEvent({
        db,
        organizationId,
        eventType: 'listing_published',
        sourceEntityType: 'listing',
        sourceEntityId: payload.listing_id,
        idempotencyKey: `listing_published:${payload.listing_id}`,
        amount: payload.price ?? null,
        currency: payload.currency ?? 'AED',
        membershipId: payload.agent_membership_id ?? null,
        displayPayload: {
          headline: payload.is_exclusive ? 'New exclusive listing' : 'New listing published',
          reference: payload.reference,
          title: payload.title,
          offering_type: payload.offering_type,
          property_type: payload.property_type,
          price: payload.price ?? null,
          currency: payload.currency ?? 'AED',
          is_exclusive: Boolean(payload.is_exclusive),
        },
      });
      break;
    }

    case EVENT_TYPES.RESERVATION_CREATED: {
      await createSalesEvent({
        db,
        organizationId,
        eventType: 'reservation_created',
        sourceEntityType: 'reservation',
        sourceEntityId: payload.reservation_id,
        idempotencyKey: `reservation_created:${payload.reservation_id}`,
        amount: payload.amount ?? null,
        currency: payload.currency ?? 'AED',
        membershipId: payload.agent_membership_id ?? null,
        projectId: payload.project_id ?? null,
        displayPayload: { headline: 'Unit reserved', reference: payload.reference, unit_number: payload.unit_number ?? null },
      });
      break;
    }

    case EVENT_TYPES.BOOKING_CREATED: {
      await createSalesEvent({
        db,
        organizationId,
        eventType: 'booking_created',
        sourceEntityType: 'booking',
        sourceEntityId: payload.booking_id,
        idempotencyKey: `booking_created:${payload.booking_id}`,
        membershipId: payload.agent_membership_id ?? null,
        displayPayload: { headline: 'Booking confirmed', reference: payload.reference },
      });
      break;
    }

    case EVENT_TYPES.VIEWING_COMPLETED: {
      await awardPoints({
        db,
        organizationId,
        eventType: 'viewing_completed',
        membershipId: payload.agent_membership_id ?? null,
        sourceEntityType: 'viewing',
        sourceEntityId: payload.viewing_id,
      });
      break;
    }

    case EVENT_TYPES.LEAD_STAGE_CHANGED: {
      if (payload.to === 'qualified') {
        const lead = await db('leads').where({ id: payload.lead_id, organization_id: organizationId }).first('assigned_membership_id', 'team_id', 'branch_id');
        await awardPoints({
          db,
          organizationId,
          eventType: 'lead_qualified',
          membershipId: lead?.assigned_membership_id ?? null,
          teamId: lead?.team_id ?? null,
          branchId: lead?.branch_id ?? null,
          sourceEntityType: 'lead',
          sourceEntityId: payload.lead_id,
        });
      }
      break;
    }

    case EVENT_TYPES.DEAL_CANCELLED: {
      await reversePointsFor({ db, organizationId, sourceEntityType: 'deal', sourceEntityId: payload.deal_id, reason: payload.reason ?? 'deal cancelled' });
      break;
    }

    default:
      break;
  }

  // Workflow triggers
  const workflowMapping = WORKFLOW_TRIGGER_BY_EVENT[event.event_type];
  if (workflowMapping) {
    await dispatchTrigger({
      db,
      organizationId,
      triggerType: workflowMapping.trigger,
      entityType: workflowMapping.entityType,
      entityId: event.aggregate_id,
      payload,
    });
  }

  // Outbound webhook subscriptions
  const endpoints = await db('webhook_endpoints')
    .where({ organization_id: organizationId, status: 'active' })
    .whereNull('deleted_at');
  for (const endpoint of endpoints) {
    const eventTypes = typeof endpoint.event_types === 'string' ? JSON.parse(endpoint.event_types) : endpoint.event_types ?? [];
    if (!eventTypes.includes(event.event_type) && !eventTypes.includes('*')) continue;
    await db('webhook_deliveries').insert({
      id: newId(),
      organization_id: organizationId,
      endpoint_id: endpoint.id,
      outbox_event_id: event.id,
      event_type: event.event_type,
      status: 'pending',
      payload: JSON.stringify({ event: event.event_type, id: event.id, occurred_at: event.created_at, data: payload }),
    });
  }
  return { handled: true };
}

/** Claims and processes a bounded batch of outbox events. */
export async function processOutboxBatch({ limit = 50, workerId = newId(), budgetMs = 20_000 } = {}) {
  const db = getDb();
  const startedAt = Date.now();
  const events = await claimEvents(db, { limit, workerId });
  const result = { claimed: events.length, processed: 0, failed: 0 };

  for (const event of events) {
    if (Date.now() - startedAt > budgetMs) {
      await db('outbox_events').where('id', event.id).update({ status: 'pending', locked_by: null, locked_until: null });
      continue;
    }
    try {
      await handleOutboxEvent({ db, event });
      await completeEvent(db, event.id);
      result.processed += 1;
    } catch (error) {
      logger.error('outbox_event_failed', { event_id: event.id, event_type: event.event_type, error: error.message });
      await failEvent(db, event.id, error);
      result.failed += 1;
    }
  }
  return result;
}
