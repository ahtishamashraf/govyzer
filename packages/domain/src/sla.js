import { addWorkingMinutes, DEFAULT_WORKING_HOURS } from './working-hours.js';

/**
 * Default UAE brokerage SLA. Every value is a tenant-editable seed, not a hard rule.
 */
export const DEFAULT_SLA = Object.freeze({
  acknowledge_minutes: 5,
  manager_alert_minutes: 15,
  pool_release_minutes: 30,
  working_hours_only: false,
});

const EVENT_ORDER = ['acknowledge', 'manager_alert', 'pool_release'];

const FIELD_BY_EVENT = {
  acknowledge: 'acknowledge_minutes',
  manager_alert: 'manager_alert_minutes',
  pool_release: 'pool_release_minutes',
};

/**
 * Produces the SLA timeline for a lead. Returns one entry per configured escalation step;
 * disabled steps (null minutes) are omitted entirely.
 */
export function buildSlaSchedule({
  rule = DEFAULT_SLA,
  from = new Date(),
  workingHours = DEFAULT_WORKING_HOURS,
}) {
  const useWorkingHours = rule.working_hours_only === true;
  const hours = rule.working_hours ?? workingHours;

  return EVENT_ORDER.flatMap((eventType) => {
    const minutes = rule[FIELD_BY_EVENT[eventType]];
    if (minutes == null) return [];
    const dueAt = useWorkingHours
      ? addWorkingMinutes(from, minutes, hours)
      : new Date(from.getTime() + minutes * 60_000);
    return [{ event_type: eventType, due_at: dueAt, minutes }];
  });
}

/** Decides what to do when an SLA timer fires and the lead is still unacknowledged. */
export function resolveSlaBreach({ eventType, lead, rule = DEFAULT_SLA }) {
  if (lead.acknowledged_at || lead.first_response_at) {
    return { action: 'none', reason: 'lead_already_acknowledged' };
  }
  if (['won', 'lost', 'junk'].includes(lead.status)) {
    return { action: 'none', reason: 'lead_closed' };
  }

  switch (eventType) {
    case 'acknowledge':
      return { action: 'notify_agent', reason: 'acknowledgement_reminder' };
    case 'manager_alert':
      return { action: 'notify_manager', reason: 'manager_escalation' };
    case 'pool_release':
      return rule.pool_release_minutes == null
        ? { action: 'none', reason: 'pool_release_disabled' }
        : { action: 'release_to_pool', reason: 'sla_pool_release' };
    default:
      return { action: 'none', reason: 'unknown_event' };
  }
}
