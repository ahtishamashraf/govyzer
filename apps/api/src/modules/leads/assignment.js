import { getDb } from '@govyzer/database';
import { newId, selectAssignee } from '@govyzer/domain';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';

/** Loads assignable memberships plus the workload signals the engine scores on. */
export async function loadCandidates({ trx, organizationId, module }) {
  const db = trx ?? getDb();
  const rows = await db('organization_memberships as m')
    .where('m.organization_id', organizationId)
    .where('m.status', 'active')
    .whereNull('m.deleted_at')
    .select('m.id', 'm.team_id', 'm.branch_id', 'm.modules', 'm.capacity_limit', 'm.working_hours', 'm.languages', 'm.specialities', 'm.is_assignable', 'm.status', 'm.manager_membership_id');

  if (rows.length === 0) return [];

  const workload = await db('leads')
    .where('organization_id', organizationId)
    .whereIn('status', ['open'])
    .whereNull('deleted_at')
    .whereNotNull('assigned_membership_id')
    .groupBy('assigned_membership_id')
    .select('assigned_membership_id')
    .count({ open_leads: 'id' });

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const assignedToday = await db('lead_assignments')
    .where('organization_id', organizationId)
    .where('assigned_at', '>=', todayStart)
    .groupBy('membership_id')
    .select('membership_id')
    .count({ assigned_today: 'id' });

  const lastAssigned = await db('lead_assignments')
    .where('organization_id', organizationId)
    .groupBy('membership_id')
    .select('membership_id')
    .max({ last_assigned_at: 'assigned_at' });

  const workloadMap = new Map(workload.map((row) => [row.assigned_membership_id, Number(row.open_leads)]));
  const todayMap = new Map(assignedToday.map((row) => [row.membership_id, Number(row.assigned_today)]));
  const lastMap = new Map(lastAssigned.map((row) => [row.membership_id, row.last_assigned_at]));

  const parse = (value, fallback) => {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  return rows
    .map((row) => ({
      id: row.id,
      team_id: row.team_id,
      branch_id: row.branch_id,
      manager_membership_id: row.manager_membership_id,
      status: row.status,
      is_assignable: Boolean(row.is_assignable),
      modules: parse(row.modules, []),
      capacity_limit: row.capacity_limit,
      working_hours: parse(row.working_hours, null),
      languages: parse(row.languages, []),
      specialities: parse(row.specialities, {}),
      open_lead_count: workloadMap.get(row.id) ?? 0,
      assigned_today: todayMap.get(row.id) ?? 0,
      last_assigned_at: lastMap.get(row.id) ?? null,
      weight: parse(row.specialities, {})?.weight ?? 1,
    }))
    .filter((candidate) => !module || candidate.modules.length === 0 || candidate.modules.includes(module));
}

/**
 * Applies the assignment engine and persists the decision plus its full explanation. A
 * lead is never left without an owner: the manager queue is the last resort.
 */
export async function assignLead({ trx, organizationId, lead, actor = null, manualMembershipId = null, reason = null }) {
  const db = trx ?? getDb();

  const listing = lead.listing_id
    ? await db('listings').where({ id: lead.listing_id, organization_id: organizationId }).first()
    : null;
  const project = lead.project_id
    ? await db('projects').where({ id: lead.project_id, organization_id: organizationId }).first()
    : null;

  const candidates = await loadCandidates({ trx: db, organizationId, module: lead.module });
  const rules = await db('lead_assignment_rules')
    .where({ organization_id: organizationId, is_active: true })
    .whereNull('deleted_at')
    .orderBy('priority')
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        conditions: typeof row.conditions === 'string' ? JSON.parse(row.conditions ?? '{}') : row.conditions,
        targets: typeof row.targets === 'string' ? JSON.parse(row.targets ?? '{}') : row.targets,
        fallback: typeof row.fallback === 'string' ? JSON.parse(row.fallback ?? '{}') : row.fallback,
      }))
    );

  if (project?.assignment_policy) {
    const policy = typeof project.assignment_policy === 'string' ? JSON.parse(project.assignment_policy) : project.assignment_policy;
    rules.unshift({
      id: `project:${project.id}`,
      name: `Project policy: ${project.name}`,
      module: 'offplan',
      priority: 0,
      is_active: true,
      conditions: { projectId: project.id },
      strategy: policy.strategies ?? ['project_manager_inbox'],
      targets: { membership_ids: policy.membership_ids ?? [], team_ids: policy.team_ids ?? [] },
      fallback: { membership_id: project.default_manager_membership_id ?? null },
      respect_capacity: policy.respect_capacity !== false,
    });
  }

  const managerMembershipId =
    lead.manager_membership_id ??
    listing?.manager_membership_id ??
    project?.default_manager_membership_id ??
    (await db('organization_memberships as m')
      .join('membership_roles as mr', 'mr.membership_id', 'm.id')
      .join('roles as r', 'r.id', 'mr.role_id')
      .where('m.organization_id', organizationId)
      .where('m.status', 'active')
      .whereIn('r.code', ['sales_manager', 'branch_manager', 'org_owner'])
      .orderBy('r.priority')
      .first('m.id')
      .then((row) => row?.id ?? null));

  const decision = manualMembershipId
    ? {
        membershipId: manualMembershipId,
        reason: reason ?? 'manual_assignment',
        strategy: 'manual',
        ruleId: null,
        evaluatedRules: [],
        candidates: [],
        fallbackUsed: false,
      }
    : selectAssignee({
        lead: { ...lead, source_code: lead.source_code ?? null },
        listing,
        project,
        rules,
        candidates,
        managerMembershipId,
      });

  const previousMembershipId = lead.assigned_membership_id ?? null;

  if (decision.membershipId) {
    await db('lead_assignments')
      .where({ organization_id: organizationId, lead_id: lead.id, is_active: true })
      .update({ is_active: false, unassigned_at: db.fn.now() });
    await db('lead_assignments').insert({
      id: newId(),
      organization_id: organizationId,
      lead_id: lead.id,
      membership_id: decision.membershipId,
      assignment_role: 'primary',
      is_active: true,
    });

    const assignedMembership = candidates.find((candidate) => candidate.id === decision.membershipId);
    await db('leads')
      .where({ id: lead.id, organization_id: organizationId })
      .update({
        assigned_membership_id: decision.membershipId,
        manager_membership_id: assignedMembership?.manager_membership_id ?? managerMembershipId,
        team_id: assignedMembership?.team_id ?? lead.team_id ?? null,
        branch_id: assignedMembership?.branch_id ?? lead.branch_id ?? null,
        assigned_at: db.fn.now(),
        is_in_pool: false,
        updated_at: db.fn.now(),
      });
  }

  await db('lead_assignment_history').insert({
    id: newId(),
    organization_id: organizationId,
    lead_id: lead.id,
    rule_id: typeof decision.ruleId === 'string' && decision.ruleId.startsWith('project:') ? null : decision.ruleId,
    strategy: decision.strategy,
    evaluated_rules: JSON.stringify(decision.evaluatedRules ?? []),
    candidates: JSON.stringify(decision.candidates ?? []),
    previous_membership_id: previousMembershipId,
    selected_membership_id: decision.membershipId,
    reason: decision.reason,
    decided_by_membership_id: actor?.membershipId ?? null,
    is_manual_override: Boolean(manualMembershipId),
  });

  if (decision.membershipId) {
    await emitEvent(db, {
      organizationId,
      eventType: EVENT_TYPES.LEAD_ASSIGNED,
      aggregateType: 'lead',
      aggregateId: lead.id,
      payload: {
        lead_id: lead.id,
        membership_id: decision.membershipId,
        previous_membership_id: previousMembershipId,
        reason: decision.reason,
        strategy: decision.strategy,
      },
    });
    await db('notifications').insert({
      id: newId(),
      organization_id: organizationId,
      membership_id: decision.membershipId,
      type: 'lead.assigned',
      title: 'New lead assigned',
      body: `Lead ${lead.reference} was assigned to you (${decision.reason}).`,
      data: JSON.stringify({ lead_id: lead.id, reference: lead.reference }),
      entity_type: 'lead',
      entity_id: lead.id,
      priority: 'high',
    });
  }

  return decision;
}
