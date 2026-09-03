import { isWithinWorkingHours, DEFAULT_WORKING_HOURS } from './working-hours.js';

/**
 * Pure lead assignment engine. Callers load candidates and rules from the database, the
 * engine decides and returns a fully explained decision that is persisted to
 * lead_assignment_history.
 */

export function isCandidateEligible(candidate, { module, now = new Date(), respectCapacity = true } = {}) {
  const reasons = [];
  if (candidate.status !== 'active') reasons.push('membership_inactive');
  if (candidate.is_assignable === false) reasons.push('not_assignable');
  if (module && Array.isArray(candidate.modules) && !candidate.modules.includes(module)) {
    reasons.push('module_not_enabled');
  }
  if (
    respectCapacity &&
    candidate.capacity_limit != null &&
    (candidate.open_lead_count ?? 0) >= candidate.capacity_limit
  ) {
    reasons.push('over_capacity');
  }
  if (candidate.working_hours && !isWithinWorkingHours(now, candidate.working_hours)) {
    reasons.push('outside_working_hours');
  }
  if (candidate.is_available === false) reasons.push('unavailable');
  return { eligible: reasons.length === 0, reasons };
}

function evaluateConditions(conditions, context) {
  if (!conditions || Object.keys(conditions).length === 0) return true;
  return Object.entries(conditions).every(([key, expected]) => {
    const actual = context[key];
    if (Array.isArray(expected)) return expected.includes(actual);
    if (expected && typeof expected === 'object') {
      if (expected.min != null && !(Number(actual) >= Number(expected.min))) return false;
      if (expected.max != null && !(Number(actual) <= Number(expected.max))) return false;
      return true;
    }
    return actual === expected;
  });
}

function score(candidate, strategy, context) {
  switch (strategy) {
    case 'weighted_round_robin':
      return (candidate.weight ?? 1) / (1 + (candidate.assigned_today ?? 0));
    case 'least_workload':
      return -(candidate.open_lead_count ?? 0);
    case 'language_match':
      return (candidate.languages ?? []).includes(context.language) ? 1 : 0;
    case 'project_specialist':
      return (candidate.specialities?.projects ?? []).includes(context.projectId) ? 1 : 0;
    case 'area_specialist':
      return (candidate.specialities?.communities ?? []).includes(context.communityId) ? 1 : 0;
    case 'property_type':
      return (candidate.specialities?.property_types ?? []).includes(context.propertyType) ? 1 : 0;
    case 'budget_band':
      return (candidate.specialities?.budget_bands ?? []).some(
        (band) => Number(context.budget) >= Number(band.min) && Number(context.budget) <= Number(band.max)
      )
        ? 1
        : 0;
    case 'source_owner':
      return (candidate.specialities?.sources ?? []).includes(context.sourceCode) ? 1 : 0;
    case 'shift':
      return candidate.working_hours && isWithinWorkingHours(context.now, candidate.working_hours) ? 1 : 0;
    case 'round_robin':
    default:
      return -(candidate.last_assigned_at ? new Date(candidate.last_assigned_at).getTime() : 0);
  }
}

function pick(candidates, strategies, context) {
  const ordered = [...candidates].sort((a, b) => {
    for (const strategy of strategies) {
      const diff = score(b, strategy, context) - score(a, strategy, context);
      if (diff !== 0) return diff;
    }
    // Deterministic tie break so tests and audits are reproducible.
    return String(a.id).localeCompare(String(b.id));
  });
  return ordered[0] ?? null;
}

/**
 * Default priority order (tenant administrators may reorder through rules):
 *   1. eligible primary agent of the referenced ready listing
 *   2. the listing's configured fallback membership / team / manager
 *   3. the project's configured off-plan policy
 *   4. the responsible manager queue — never dropped
 */
export function selectAssignee({
  lead,
  listing = null,
  project = null,
  rules = [],
  candidates = [],
  managerMembershipId = null,
  now = new Date(),
}) {
  const evaluated = [];
  const context = {
    module: lead.module,
    language: lead.language,
    projectId: lead.project_id ?? project?.id ?? null,
    communityId: listing?.community_id ?? project?.community_id ?? null,
    propertyType: listing?.property_type ?? null,
    budget: lead.estimated_value ?? null,
    sourceCode: lead.source_code ?? null,
    stage: lead.stage_code,
    now,
  };

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const eligibility = new Map(
    candidates.map((candidate) => [
      candidate.id,
      isCandidateEligible(candidate, { module: lead.module, now }),
    ])
  );

  const decide = (membershipId, reason, extra = {}) => ({
    membershipId,
    reason,
    strategy: extra.strategy ?? null,
    ruleId: extra.ruleId ?? null,
    evaluatedRules: evaluated,
    candidates: candidates.map((candidate) => ({
      membership_id: candidate.id,
      eligible: eligibility.get(candidate.id)?.eligible ?? false,
      reasons: eligibility.get(candidate.id)?.reasons ?? [],
    })),
    fallbackUsed: extra.fallbackUsed ?? false,
  });

  // 1 + 2: ready listing agent, then its configured fallback.
  if (listing && lead.module === 'ready') {
    const agentId = listing.primary_agent_membership_id;
    evaluated.push({ rule: 'listing_agent', matched: Boolean(agentId) });
    if (agentId && eligibility.get(agentId)?.eligible) {
      return decide(agentId, 'listing_primary_agent', { strategy: 'listing_agent' });
    }
    const fallbackCandidates = candidates.filter(
      (candidate) =>
        candidate.id === listing.fallback_membership_id ||
        candidate.id === listing.manager_membership_id ||
        (listing.fallback_team_id && candidate.team_id === listing.fallback_team_id)
    );
    const eligibleFallback = fallbackCandidates.filter((candidate) => eligibility.get(candidate.id)?.eligible);
    if (eligibleFallback.length > 0) {
      const selected = pick(eligibleFallback, ['least_workload', 'round_robin'], context);
      return decide(selected.id, 'listing_fallback', {
        strategy: 'listing_fallback',
        fallbackUsed: true,
      });
    }
  }

  // 3: tenant configured rules (includes off-plan project policy translated into a rule).
  const applicable = [...rules]
    .filter((rule) => rule.is_active !== false)
    .filter((rule) => !rule.module || rule.module === lead.module)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  for (const rule of applicable) {
    const matched = evaluateConditions(rule.conditions, context);
    evaluated.push({ rule_id: rule.id, name: rule.name, matched });
    if (!matched) continue;

    const targetIds = new Set(
      (rule.targets?.membership_ids ?? []).concat(
        candidates
          .filter((candidate) => (rule.targets?.team_ids ?? []).includes(candidate.team_id))
          .map((candidate) => candidate.id)
      )
    );
    const pool = targetIds.size > 0 ? candidates.filter((c) => targetIds.has(c.id)) : candidates;
    const eligible = pool.filter((candidate) => {
      const result = isCandidateEligible(candidate, {
        module: lead.module,
        now,
        respectCapacity: rule.respect_capacity !== false,
      });
      eligibility.set(candidate.id, result);
      return result.eligible;
    });

    if (eligible.length > 0) {
      const strategies = Array.isArray(rule.strategy) ? rule.strategy : [rule.strategy ?? 'round_robin'];
      const selected = pick(eligible, strategies, context);
      return decide(selected.id, `rule:${rule.name}`, {
        strategy: strategies.join('+'),
        ruleId: rule.id,
      });
    }

    if (rule.fallback?.membership_id && byId.has(rule.fallback.membership_id)) {
      return decide(rule.fallback.membership_id, `rule_fallback:${rule.name}`, {
        strategy: 'rule_fallback',
        ruleId: rule.id,
        fallbackUsed: true,
      });
    }
  }

  // Off-plan project default manager inbox.
  if (project?.default_manager_membership_id) {
    evaluated.push({ rule: 'project_default_manager', matched: true });
    return decide(project.default_manager_membership_id, 'project_default_manager', {
      strategy: 'project_manager_inbox',
      fallbackUsed: true,
    });
  }

  // 4: responsible manager queue. A lead is never dropped.
  if (managerMembershipId) {
    return decide(managerMembershipId, 'manager_queue', {
      strategy: 'manager_queue',
      fallbackUsed: true,
    });
  }
  return decide(null, 'unassigned_manager_queue_missing', { fallbackUsed: true });
}

export { DEFAULT_WORKING_HOURS };
