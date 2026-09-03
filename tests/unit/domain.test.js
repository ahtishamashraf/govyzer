import { describe, expect, it } from 'vitest';
import {
  authorize,
  buildLeadStageMachine,
  buildSlaSchedule,
  calculateCommission,
  DEFAULT_COMMISSION_PLAN,
  DEFAULT_LEAD_STAGES,
  distributeMinor,
  effectiveScope,
  evaluatePointsRules,
  buildLeaderboard,
  isCandidateEligible,
  listingStateMachine,
  matchCandidates,
  normalizePhone,
  reservationStateMachine,
  resolveSlaBreach,
  selectAssignee,
  toMinor,
  unitStockMachine,
  validateCommissionRules,
  addWorkingMinutes,
  buildReference,
} from '@govyzer/domain';

describe('permissions', () => {
  const actor = (overrides = {}) => ({
    isPlatformAdmin: false,
    permissions: new Set(['leads.read']),
    modules: ['ready'],
    organizationId: 'org',
    membershipId: 'mem',
    recordScope: 'assigned',
    ...overrides,
  });

  it('allows a permitted action inside an enabled module', () => {
    expect(authorize(actor(), 'leads.read')).toBe(true);
  });

  it('blocks an action when the module is not enabled', () => {
    expect(() => authorize(actor({ modules: [] }), 'leads.read')).toThrow(/module is not enabled/);
  });

  it('blocks an action when the permission is missing', () => {
    expect(() => authorize(actor({ permissions: new Set() }), 'leads.read')).toThrow(/Missing permission/);
  });

  it('lets a platform admin through every check', () => {
    expect(authorize(actor({ isPlatformAdmin: true, permissions: new Set(), modules: [] }), 'leads.delete')).toBe(true);
  });

  it('resolves the widest scope across roles', () => {
    expect(effectiveScope(['own', 'branch', 'team'])).toBe('branch');
  });
});

describe('state machines', () => {
  it('allows a listing to move from approved to publishing', () => {
    expect(listingStateMachine.can('approved', 'publishing')).toBe(true);
  });

  it('refuses to move a draft listing straight to published', () => {
    expect(() => listingStateMachine.assert('draft', 'published')).toThrow(/Invalid listing transition/);
  });

  it('refuses to reserve a sold unit', () => {
    expect(unitStockMachine.can('sold', 'reserved')).toBe(false);
  });

  it('allows a reservation to convert once confirmed', () => {
    expect(reservationStateMachine.can('confirmed', 'converted')).toBe(true);
  });

  it('builds a lead stage machine from tenant stage definitions', () => {
    const machine = buildLeadStageMachine(DEFAULT_LEAD_STAGES.map((stage) => ({ code: stage.code, category: stage.category })));
    expect(machine.can('new_inquiry', 'qualified')).toBe(true);
    expect(machine.can('won', 'contacted')).toBe(true);
    expect(machine.can('won', 'unknown_stage')).toBe(false);
  });
});

describe('money', () => {
  it('distributes an amount without losing a cent', () => {
    const parts = distributeMinor(toMinor(100.01), [1, 1, 1]);
    expect(parts.reduce((sum, value) => sum + value, 0)).toBe(toMinor(100.01));
  });
});

describe('commission calculation', () => {
  const deal = { id: 'deal', deal_type: 'ready_sale', module: 'ready', gross_commission: 100000, currency: 'AED' };

  it('splits 50/50 by default and always balances', () => {
    const result = calculateCommission({ deal, context: { agentMembershipId: 'agent-1' } });
    const total = result.lines.reduce((sum, line) => sum + line.amount, 0);
    expect(total).toBe(result.base_amount);
    expect(result.lines.find((line) => line.recipient_type === 'agent').amount).toBe(50000);
  });

  it('rejects percentage plans that do not total 100', () => {
    const issues = validateCommissionRules([
      { position: 1, recipient_type: 'agent', calculation_type: 'percentage', percentage: 40, applies_to: 'gross' },
      { position: 2, recipient_type: 'company', calculation_type: 'percentage', percentage: 40, applies_to: 'gross' },
    ]);
    expect(issues.some((issue) => issue.message.includes('must total 100%'))).toBe(true);
  });

  it('supports fixed lines, referral splits and a residual to the company', () => {
    const result = calculateCommission({
      plan: { code: 'referral', commission_base: 'gross_before_vat' },
      rules: [
        { position: 1, recipient_type: 'referral_partner', calculation_type: 'fixed', fixed_amount: 5000 },
        { position: 2, recipient_type: 'agent', calculation_type: 'percentage', percentage: 45, applies_to: 'gross' },
        { position: 3, recipient_type: 'company', calculation_type: 'percentage', percentage: 55, applies_to: 'gross' },
      ],
      deal,
      context: { agentMembershipId: 'agent-1', referralContactId: 'contact-1' },
    });
    const total = result.lines.reduce((sum, line) => sum + line.amount, 0);
    expect(total).toBe(result.base_amount);
    expect(result.lines.find((line) => line.recipient_type === 'referral_partner').amount).toBe(5000);
  });

  it('applies a tier when the base amount qualifies', () => {
    const result = calculateCommission({
      plan: { code: 'tiered', commission_base: 'gross_before_vat' },
      rules: [
        { position: 1, recipient_type: 'agent', calculation_type: 'percentage', applies_to: 'gross', tiers: [{ from: 0, to: 50000, percentage: 40 }, { from: 50000.01, percentage: 60 }] },
        { position: 2, recipient_type: 'company', calculation_type: 'percentage', applies_to: 'gross', tiers: [{ from: 0, to: 50000, percentage: 60 }, { from: 50000.01, percentage: 40 }] },
      ],
      deal,
      context: { agentMembershipId: 'agent-1' },
    });
    expect(result.lines.find((line) => line.recipient_type === 'agent').amount).toBe(60000);
  });

  it('honours the VAT-inclusive commission base', () => {
    const result = calculateCommission({
      plan: { ...DEFAULT_COMMISSION_PLAN, commission_base: 'gross_after_vat' },
      deal,
      context: { vatPercentage: 5, agentMembershipId: 'agent-1' },
    });
    expect(result.base_amount).toBe(105000);
  });
});

describe('lead assignment', () => {
  const baseCandidate = { id: 'agent-1', status: 'active', is_assignable: true, modules: ['ready'], open_lead_count: 2, capacity_limit: 10, team_id: 'team-1' };

  it('marks an over-capacity agent ineligible', () => {
    const result = isCandidateEligible({ ...baseCandidate, open_lead_count: 10 }, { module: 'ready' });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('over_capacity');
  });

  it('routes a ready listing enquiry to the listing agent first', () => {
    const decision = selectAssignee({
      lead: { id: 'lead-1', module: 'ready', stage_code: 'new_inquiry', language: 'en' },
      listing: { primary_agent_membership_id: 'agent-1' },
      candidates: [baseCandidate, { ...baseCandidate, id: 'agent-2' }],
      managerMembershipId: 'manager-1',
    });
    expect(decision.membershipId).toBe('agent-1');
    expect(decision.reason).toBe('listing_primary_agent');
  });

  it('falls back to the listing fallback when the primary agent is unavailable', () => {
    const decision = selectAssignee({
      lead: { id: 'lead-1', module: 'ready', stage_code: 'new_inquiry' },
      listing: { primary_agent_membership_id: 'agent-1', fallback_membership_id: 'agent-2' },
      candidates: [{ ...baseCandidate, status: 'suspended' }, { ...baseCandidate, id: 'agent-2' }],
      managerMembershipId: 'manager-1',
    });
    expect(decision.membershipId).toBe('agent-2');
    expect(decision.fallbackUsed).toBe(true);
  });

  it('never drops a lead: the manager queue is the last resort', () => {
    const decision = selectAssignee({
      lead: { id: 'lead-1', module: 'offplan', stage_code: 'new_inquiry' },
      candidates: [],
      managerMembershipId: 'manager-1',
    });
    expect(decision.membershipId).toBe('manager-1');
    expect(decision.reason).toBe('manager_queue');
  });

  it('applies a tenant rule with a strategy and records the evaluation', () => {
    const decision = selectAssignee({
      lead: { id: 'lead-1', module: 'offplan', stage_code: 'new_inquiry', project_id: 'project-1' },
      rules: [{ id: 'rule-1', name: 'Project specialists', module: 'offplan', priority: 1, conditions: { projectId: 'project-1' }, strategy: 'least_workload', targets: { membership_ids: ['agent-2'] } }],
      candidates: [
        { ...baseCandidate, id: 'agent-2', modules: ['offplan'], open_lead_count: 1 },
        { ...baseCandidate, id: 'agent-3', modules: ['offplan'], open_lead_count: 9 },
      ],
      managerMembershipId: 'manager-1',
    });
    expect(decision.membershipId).toBe('agent-2');
    expect(decision.evaluatedRules[0].matched).toBe(true);
  });
});

describe('SLA', () => {
  it('schedules acknowledge, manager alert and pool release', () => {
    const schedule = buildSlaSchedule({ from: new Date('2026-01-01T08:00:00Z') });
    expect(schedule.map((entry) => entry.event_type)).toEqual(['acknowledge', 'manager_alert', 'pool_release']);
    expect(schedule[2].due_at.toISOString()).toBe('2026-01-01T08:30:00.000Z');
  });

  it('omits a disabled escalation step', () => {
    const schedule = buildSlaSchedule({ rule: { acknowledge_minutes: 5, manager_alert_minutes: null, pool_release_minutes: null } });
    expect(schedule).toHaveLength(1);
  });

  it('does nothing when the lead was already acknowledged', () => {
    const outcome = resolveSlaBreach({ eventType: 'manager_alert', lead: { acknowledged_at: new Date(), status: 'open' } });
    expect(outcome.action).toBe('none');
  });

  it('releases to the pool on the final escalation', () => {
    const outcome = resolveSlaBreach({ eventType: 'pool_release', lead: { status: 'open' } });
    expect(outcome.action).toBe('release_to_pool');
  });

  it('adds working minutes across a closed period', () => {
    const monday = new Date('2026-01-05T17:30:00Z');
    const result = addWorkingMinutes(monday, 60);
    expect(result.getUTCDate()).toBe(6);
  });
});

describe('points', () => {
  it('awards points for a won deal and reverses cleanly', () => {
    const entries = evaluatePointsRules({ eventType: 'deal_won', amount: 2000000 });
    expect(entries.some((entry) => entry.rule_code === 'won_deal')).toBe(true);
    const leaderboard = buildLeaderboard([
      { membership_id: 'a', points: 50 },
      { membership_id: 'b', points: 80 },
      { membership_id: 'a', points: -50 },
    ]);
    expect(leaderboard[0]).toEqual({ key: 'b', points: 80, rank: 1 });
  });

  it('only awards an exclusive listing bonus when the condition matches', () => {
    const withExclusive = evaluatePointsRules({ eventType: 'listing_published', context: { is_exclusive: true } });
    const withoutExclusive = evaluatePointsRules({ eventType: 'listing_published', context: { is_exclusive: false } });
    expect(withExclusive).toHaveLength(2);
    expect(withoutExclusive).toHaveLength(1);
  });
});

describe('matching', () => {
  it('filters on hard requirements before ranking', () => {
    const matches = matchCandidates(
      { property_types: ['apartment'], bedrooms_min: 2, bedrooms_max: 2, budget_max: 2000000 },
      [
        { id: 'u1', property_type: 'apartment', bedrooms: 2, price: 1900000, size: 1200 },
        { id: 'u2', property_type: 'villa', bedrooms: 2, price: 1900000, size: 3000 },
        { id: 'u3', property_type: 'apartment', bedrooms: 4, price: 1900000, size: 2200 },
      ]
    );
    expect(matches.map((match) => match.id)).toEqual(['u1']);
    expect(matches[0].match_reasons).toContain('within_budget');
  });
});

describe('references and identifiers', () => {
  it('normalizes UAE mobile numbers to one canonical form', () => {
    expect(normalizePhone('0501234567')).toBe('+971501234567');
    expect(normalizePhone('+971 50 123 4567')).toBe('+971501234567');
    expect(normalizePhone('00971501234567')).toBe('+971501234567');
  });

  it('builds a tenant reference from a pattern', () => {
    const reference = buildReference({ entity: 'lead', prefix: 'LUX', sequence: 42, date: new Date('2026-01-15T00:00:00Z') });
    expect(reference).toBe('LUX-LD-2601-000042');
  });
});
