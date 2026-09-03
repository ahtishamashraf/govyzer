import { getDb } from '@govyzer/database';
import { newId, buildSlaSchedule, resolveSlaBreach, DEFAULT_SLA } from '@govyzer/domain';
import { enqueueJob } from '../../core/jobs.js';
import { JOB_TYPES } from '../../jobs/index.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';

export async function loadSlaRule({ trx, organizationId, module }) {
  const db = trx ?? getDb();
  const rule = await db('lead_sla_rules')
    .where({ organization_id: organizationId, module, is_active: true })
    .whereNull('deleted_at')
    .orderBy('created_at')
    .first();
  if (!rule) return { ...DEFAULT_SLA, id: null };
  return {
    ...rule,
    working_hours: typeof rule.working_hours === 'string' ? JSON.parse(rule.working_hours ?? 'null') : rule.working_hours,
    actions: typeof rule.actions === 'string' ? JSON.parse(rule.actions ?? '{}') : rule.actions,
  };
}

/** Schedules the SLA timeline for a lead and queues the checks that enforce it. */
export async function scheduleSla({ trx, organizationId, lead }) {
  const db = trx ?? getDb();
  const rule = await loadSlaRule({ trx: db, organizationId, module: lead.module });
  const schedule = buildSlaSchedule({ rule, from: new Date() });
  if (schedule.length === 0) return [];

  const rows = schedule.map((entry) => ({
    id: newId(),
    organization_id: organizationId,
    lead_id: lead.id,
    rule_id: rule.id ?? null,
    event_type: entry.event_type,
    due_at: entry.due_at,
    status: 'scheduled',
  }));
  await db('lead_sla_events').insert(rows);
  await db('leads').where('id', lead.id).update({ sla_due_at: schedule[0].due_at, sla_status: 'pending' });

  for (const row of rows) {
    await enqueueJob({
      organizationId,
      jobType: JOB_TYPES.LEAD_SLA_CHECK,
      payload: { lead_id: lead.id, sla_event_id: row.id, event_type: row.event_type },
      runAfter: row.due_at,
      dedupeKey: `sla:${row.id}`,
      trx: db,
    });
  }
  return rows;
}

/** Executes one SLA timer. Called by the job runner and by the cron sweep. */
export async function processSlaEvent({ db, organizationId, slaEventId }) {
  const event = await db('lead_sla_events').where({ id: slaEventId, organization_id: organizationId }).first();
  if (!event || event.status !== 'scheduled') return { skipped: true, reason: 'not_scheduled' };

  const lead = await db('leads').where({ id: event.lead_id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!lead) {
    await db('lead_sla_events').where('id', event.id).update({ status: 'cancelled', resolved_at: db.fn.now() });
    return { skipped: true, reason: 'lead_missing' };
  }

  const rule = await loadSlaRule({ trx: db, organizationId, module: lead.module });
  const outcome = resolveSlaBreach({ eventType: event.event_type, lead, rule });

  if (outcome.action === 'none') {
    await db('lead_sla_events').where('id', event.id).update({
      status: 'resolved',
      resolved_at: db.fn.now(),
      result: JSON.stringify(outcome),
    });
    return { action: 'none', reason: outcome.reason };
  }

  await db('lead_sla_events').where('id', event.id).update({
    status: 'triggered',
    triggered_at: db.fn.now(),
    result: JSON.stringify(outcome),
  });
  await db('leads').where('id', lead.id).update({ sla_status: 'breached', updated_at: db.fn.now() });

  if (outcome.action === 'notify_agent' && lead.assigned_membership_id) {
    await notify(db, organizationId, lead.assigned_membership_id, 'lead.sla_reminder', 'Respond to your new lead', `Lead ${lead.reference} is still awaiting your first response.`, lead);
  }
  if (outcome.action === 'notify_manager' && lead.manager_membership_id) {
    await notify(db, organizationId, lead.manager_membership_id, 'lead.sla_escalated', 'Lead SLA breached', `Lead ${lead.reference} has not been acknowledged.`, lead);
  }
  if (outcome.action === 'release_to_pool') {
    await db('lead_pool_entries').insert({
      id: newId(),
      organization_id: organizationId,
      lead_id: lead.id,
      status: 'available',
      release_reason: 'sla_pool_release',
      released_at: db.fn.now(),
    });
    await db('leads').where('id', lead.id).update({ is_in_pool: true, assigned_membership_id: null, updated_at: db.fn.now() });
    await db('lead_assignments').where({ lead_id: lead.id, is_active: true }).update({ is_active: false, unassigned_at: db.fn.now() });
  }

  await emitEvent(db, {
    organizationId,
    eventType: EVENT_TYPES.LEAD_SLA_BREACHED,
    aggregateType: 'lead',
    aggregateId: lead.id,
    payload: { lead_id: lead.id, event_type: event.event_type, action: outcome.action },
  });
  return outcome;
}

async function notify(db, organizationId, membershipId, type, title, body, lead) {
  await db('notifications').insert({
    id: newId(),
    organization_id: organizationId,
    membership_id: membershipId,
    type,
    title,
    body,
    data: JSON.stringify({ lead_id: lead.id, reference: lead.reference }),
    entity_type: 'lead',
    entity_id: lead.id,
    priority: 'high',
  });
}
