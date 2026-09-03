import { toMinor } from './money.js';

/** Editable seed rules. Tenants change points, conditions and eligibility freely. */
export const DEFAULT_POINTS_RULES = Object.freeze([
  { code: 'qualified_lead', name: 'Qualified lead', event_type: 'lead_qualified', points: 5, calculation: 'fixed' },
  { code: 'completed_viewing', name: 'Completed viewing', event_type: 'viewing_completed', points: 10, calculation: 'fixed' },
  { code: 'exclusive_listing', name: 'Exclusive listing', event_type: 'listing_published', points: 15, calculation: 'fixed', conditions: { is_exclusive: true } },
  { code: 'new_listing', name: 'Published listing', event_type: 'listing_published', points: 5, calculation: 'fixed' },
  { code: 'reservation', name: 'Off-plan reservation', event_type: 'reservation_created', points: 25, calculation: 'fixed' },
  { code: 'won_deal', name: 'Won deal', event_type: 'deal_won', points: 50, calculation: 'fixed' },
  {
    code: 'revenue_points',
    name: 'Revenue points',
    event_type: 'deal_won',
    points: 0,
    calculation: 'per_amount',
    points_per_amount: 1,
    conditions: {},
  },
]);

function matches(conditions, context) {
  if (!conditions || Object.keys(conditions).length === 0) return true;
  return Object.entries(conditions).every(([key, expected]) => {
    const actual = context[key];
    if (Array.isArray(expected)) return expected.includes(actual);
    return actual === expected;
  });
}

/**
 * Returns one ledger entry per matching rule. Points are never mutated in place: a
 * reversal writes a negative entry that references the original.
 */
export function evaluatePointsRules({ eventType, rules = DEFAULT_POINTS_RULES, context = {}, amount = 0 }) {
  const now = context.occurredAt ?? new Date();
  return rules
    .filter((rule) => rule.is_active !== false)
    .filter((rule) => rule.event_type === eventType)
    .filter((rule) => matches(rule.conditions, context))
    .filter((rule) => {
      if (rule.effective_from && new Date(rule.effective_from) > now) return false;
      if (rule.effective_to && new Date(rule.effective_to) < now) return false;
      return true;
    })
    .map((rule) => {
      const points =
        rule.calculation === 'per_amount'
          ? Math.floor((toMinor(amount) / 100 / 10_000) * Number(rule.points_per_amount ?? 0))
          : Number(rule.points ?? 0);
      return {
        rule_id: rule.id ?? null,
        rule_code: rule.code,
        rule_version: rule.version_number ?? 1,
        event_type: eventType,
        points,
      };
    })
    .filter((entry) => entry.points !== 0);
}

export function reversePointsEntry(entry) {
  return {
    ...entry,
    points: -entry.points,
    reverses_entry_id: entry.id ?? null,
  };
}

/** Recomputes a leaderboard from ledger rows. Display totals are never authoritative. */
export function buildLeaderboard(entries, { groupBy = 'membership_id', limit = 10 } = {}) {
  const totals = new Map();
  for (const entry of entries) {
    const key = entry[groupBy];
    if (!key) continue;
    totals.set(key, (totals.get(key) ?? 0) + Number(entry.points ?? 0));
  }
  return [...totals.entries()]
    .map(([key, points]) => ({ key, points }))
    .sort((a, b) => b.points - a.points || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
