import { getDb, reserializeJsonColumn } from '@govyzer/database';
import {
  newId,
  NotFoundError,
  ValidationError,
  calculateCommission,
  DEFAULT_COMMISSION_PLAN,
  reverseCommissionSnapshot,
} from '@govyzer/domain';

const SCOPE_SPECIFICITY = { membership: 5, team: 4, branch: 3, project: 3, source: 2, deal_type: 2, role: 2, organization: 1 };

/**
 * Chooses the commission plan for a deal. Assignments are ranked by how specific their
 * scope is, then by their configured priority, then by effective date.
 */
export async function resolveCommissionPlan({ trx, organizationId, deal, explicitPlanId = null }) {
  const db = trx ?? getDb();

  if (explicitPlanId) {
    const plan = await db('commission_plans').where({ id: explicitPlanId, organization_id: organizationId }).whereNull('deleted_at').first();
    if (!plan) throw new NotFoundError('Commission plan');
    return plan;
  }

  const assignments = await db('commission_plan_assignments as a')
    .join('commission_plans as p', 'p.id', 'a.plan_id')
    .where('a.organization_id', organizationId)
    .where('a.is_active', true)
    .where('p.is_active', true)
    .whereNull('p.deleted_at')
    .select('a.*', 'p.code as plan_code');

  const today = new Date();
  const applicable = assignments.filter((assignment) => {
    if (assignment.effective_from && new Date(assignment.effective_from) > today) return false;
    if (assignment.effective_to && new Date(assignment.effective_to) < today) return false;
    if (assignment.deal_type && assignment.deal_type !== deal.deal_type) return false;
    if (assignment.project_id && assignment.project_id !== deal.project_id) return false;
    switch (assignment.scope_type) {
      case 'membership':
        return assignment.scope_id === deal.agent_membership_id;
      case 'team':
        return assignment.scope_id === deal.team_id;
      case 'branch':
        return assignment.scope_id === deal.branch_id;
      case 'project':
        return assignment.scope_id === deal.project_id;
      case 'source':
        return assignment.scope_id === deal.source_id;
      case 'organization':
        return true;
      default:
        return false;
    }
  });

  applicable.sort((a, b) => {
    const specificity = (SCOPE_SPECIFICITY[b.scope_type] ?? 0) - (SCOPE_SPECIFICITY[a.scope_type] ?? 0);
    if (specificity !== 0) return specificity;
    return (a.priority ?? 100) - (b.priority ?? 100);
  });

  if (applicable.length > 0) {
    return db('commission_plans').where('id', applicable[0].plan_id).first();
  }
  return db('commission_plans').where({ organization_id: organizationId, is_default: true }).whereNull('deleted_at').first();
}

export async function loadPlanRules({ trx, organizationId, planId }) {
  const db = trx ?? getDb();
  const rules = await db('commission_rules')
    .where({ organization_id: organizationId, plan_id: planId, is_active: true })
    .orderBy('position');
  return rules.map((rule) => ({
    ...rule,
    percentage: rule.percentage == null ? null : Number(rule.percentage),
    fixed_amount: rule.fixed_amount == null ? null : Number(rule.fixed_amount),
    cap_amount: rule.cap_amount == null ? null : Number(rule.cap_amount),
    conditions: typeof rule.conditions === 'string' ? JSON.parse(rule.conditions ?? '{}') : rule.conditions,
    tiers: typeof rule.tiers === 'string' ? JSON.parse(rule.tiers ?? 'null') : rule.tiers,
  }));
}

/** Calculates the split without persisting it — used by the deal preview screen. */
export async function previewCommission({ organizationId, deal, actor, planId = null, manualOverrides = [] }) {
  const db = getDb();
  const plan = await resolveCommissionPlan({ organizationId, deal, explicitPlanId: planId });

  const rules = plan ? await loadPlanRules({ organizationId, planId: plan.id }) : DEFAULT_COMMISSION_PLAN.rules;
  const parties = await db('deal_parties').where({ organization_id: organizationId, deal_id: deal.id });

  return calculateCommission({
    plan: plan
      ? { code: plan.code, commission_base: plan.commission_base, version: plan.version ?? 1, id: plan.id }
      : DEFAULT_COMMISSION_PLAN,
    rules,
    deal,
    context: {
      vatPercentage: actor?.vatPercentage ?? 5,
      agentMembershipId: deal.agent_membership_id,
      managerMembershipId: deal.manager_membership_id,
      referralContactId: parties.find((party) => party.party_role === 'referral_partner')?.contact_id ?? null,
      externalBrokerContactId: parties.find((party) => party.party_role === 'external_broker')?.contact_id ?? null,
      sourceId: deal.source_id ?? null,
    },
    manualOverrides,
  });
}

/**
 * Persists an immutable commission snapshot with its calculated lines. Later plan edits
 * never rewrite a snapshot that has already been taken.
 */
export async function finalizeCommission({ trx, organizationId, actor, deal, planId = null, manualOverrides = [] }) {
  const db = trx ?? getDb();
  const plan = await resolveCommissionPlan({ trx: db, organizationId, deal, explicitPlanId: planId ?? deal.commission_plan_id });
  const rules = plan ? await loadPlanRules({ trx: db, organizationId, planId: plan.id }) : DEFAULT_COMMISSION_PLAN.rules;
  const parties = await db('deal_parties').where({ organization_id: organizationId, deal_id: deal.id });

  const result = calculateCommission({
    plan: plan ? { code: plan.code, commission_base: plan.commission_base, version: plan.version ?? 1, id: plan.id } : DEFAULT_COMMISSION_PLAN,
    rules,
    deal,
    context: {
      vatPercentage: actor?.vatPercentage ?? 5,
      agentMembershipId: deal.agent_membership_id,
      managerMembershipId: deal.manager_membership_id,
      referralContactId: parties.find((party) => party.party_role === 'referral_partner')?.contact_id ?? null,
      externalBrokerContactId: parties.find((party) => party.party_role === 'external_broker')?.contact_id ?? null,
      sourceId: deal.source_id ?? null,
    },
    manualOverrides,
  });

  const snapshotId = newId();
  await db('commission_snapshots').insert({
    id: snapshotId,
    organization_id: organizationId,
    deal_id: deal.id,
    plan_id: plan?.id ?? null,
    plan_code: result.plan_code,
    plan_version: result.plan_version,
    commission_base: result.commission_base,
    base_amount: result.base_amount,
    gross_commission: result.gross_commission,
    vat_amount: result.vat_amount,
    currency: result.currency,
    rules_snapshot: JSON.stringify(result.rules_snapshot),
    inputs_snapshot: JSON.stringify(result.inputs_snapshot),
    status: 'final',
    created_by_membership_id: actor?.membershipId ?? null,
  });

  await db('commission_lines').insert(
    result.lines.map((line) => ({
      id: newId(),
      organization_id: organizationId,
      snapshot_id: snapshotId,
      deal_id: deal.id,
      recipient_type: line.recipient_type,
      membership_id: line.membership_id,
      contact_id: line.contact_id,
      label: line.label,
      calculation_type: line.calculation_type,
      percentage: line.percentage,
      amount: line.amount,
      currency: result.currency,
      status: line.requires_approval || line.is_manual_override ? 'pending_approval' : 'calculated',
      is_manual_override: line.is_manual_override,
      calculation_trace: JSON.stringify(line.calculation_trace ?? {}),
    }))
  );

  await db('deals').where('id', deal.id).update({
    commission_plan_id: plan?.id ?? null,
    commission_snapshot_id: snapshotId,
    commission_status: result.lines.some((line) => line.requires_approval || line.is_manual_override) ? 'pending_approval' : 'calculated',
    commission_vat: result.vat_amount,
    net_commission: result.lines.filter((line) => line.recipient_type === 'company').reduce((sum, line) => sum + Number(line.amount), 0),
    updated_at: db.fn.now(),
  });

  return { snapshot_id: snapshotId, ...result };
}

/** Writes a reversing snapshot so a cancelled or amended deal never leaves stale money. */
export async function reverseCommission({ trx, organizationId, actor, dealId, reason }) {
  const db = trx ?? getDb();
  const snapshot = await db('commission_snapshots')
    .where({ organization_id: organizationId, deal_id: dealId, status: 'final' })
    .orderBy('created_at', 'desc')
    .first();
  if (!snapshot) return null;

  const lines = await db('commission_lines').where({ organization_id: organizationId, snapshot_id: snapshot.id });
  const reversal = reverseCommissionSnapshot({
    ...snapshot,
    base_amount: Number(snapshot.base_amount),
    gross_commission: Number(snapshot.gross_commission),
    vat_amount: Number(snapshot.vat_amount),
    lines: lines.map((line) => ({ ...line, amount: Number(line.amount) })),
  });

  const reversalId = newId();
  await db('commission_snapshots').insert({
    id: reversalId,
    organization_id: organizationId,
    deal_id: dealId,
    plan_id: snapshot.plan_id,
    plan_code: snapshot.plan_code,
    plan_version: snapshot.plan_version,
    commission_base: snapshot.commission_base,
    base_amount: reversal.base_amount,
    gross_commission: reversal.gross_commission,
    vat_amount: reversal.vat_amount,
    currency: snapshot.currency,
    // Carried over verbatim from the snapshot being reversed, re-serialized because a
    // JSON column read comes back parsed on some servers and as text on others.
    rules_snapshot: reserializeJsonColumn(snapshot.rules_snapshot, []),
    inputs_snapshot: JSON.stringify({ reason, reverses: snapshot.id }),
    status: 'reversal',
    reverses_snapshot_id: snapshot.id,
    created_by_membership_id: actor?.membershipId ?? null,
  });

  await db('commission_lines').insert(
    reversal.lines.map((line) => ({
      id: newId(),
      organization_id: organizationId,
      snapshot_id: reversalId,
      deal_id: dealId,
      recipient_type: line.recipient_type,
      membership_id: line.membership_id,
      contact_id: line.contact_id,
      label: `Reversal: ${line.label}`,
      calculation_type: line.calculation_type,
      percentage: line.percentage,
      amount: line.amount,
      currency: snapshot.currency,
      status: 'reversed',
      calculation_trace: JSON.stringify({ reversal_of: snapshot.id, reason }),
    }))
  );

  await db('commission_lines').where({ organization_id: organizationId, snapshot_id: snapshot.id }).update({ status: 'reversed' });
  await db('deals').where('id', dealId).update({ commission_status: 'reversed', updated_at: db.fn.now() });
  return reversalId;
}

export async function approveCommissionLine({ organizationId, actor, lineId, decision, reason }) {
  const db = getDb();
  const line = await db('commission_lines').where({ id: lineId, organization_id: organizationId }).first();
  if (!line) throw new NotFoundError('Commission line');
  if (line.status !== 'pending_approval') throw new ValidationError('This commission line is not awaiting approval');

  await db('commission_lines').where('id', line.id).update({
    status: decision === 'approved' ? 'approved' : 'rejected',
    approved_by_membership_id: actor.membershipId,
    calculation_trace: JSON.stringify({
      ...(typeof line.calculation_trace === 'string' ? JSON.parse(line.calculation_trace ?? '{}') : line.calculation_trace ?? {}),
      decision,
      decision_reason: reason ?? null,
    }),
  });

  const pending = await db('commission_lines').where({ organization_id: organizationId, snapshot_id: line.snapshot_id, status: 'pending_approval' }).first('id');
  if (!pending) {
    await db('deals').where('id', line.deal_id).update({ commission_status: 'approved', updated_at: db.fn.now() });
  }
  return db('commission_lines').where('id', line.id).first();
}
