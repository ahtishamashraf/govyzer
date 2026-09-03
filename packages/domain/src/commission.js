import { toMinor, fromMinor, percentageOfMinor, distributeMinor } from './money.js';
import { ValidationError } from './errors.js';

/** Seeded default: half of the commission to the closing agent, half to the company. */
export const DEFAULT_COMMISSION_PLAN = Object.freeze({
  code: 'default_50_50',
  name: 'Default 50/50',
  commission_base: 'gross_before_vat',
  rules: [
    {
      position: 1,
      recipient_type: 'agent',
      calculation_type: 'percentage',
      percentage: 50,
      applies_to: 'gross',
      label: 'Agent share',
    },
    {
      position: 2,
      recipient_type: 'company',
      calculation_type: 'percentage',
      percentage: 50,
      applies_to: 'gross',
      label: 'Company share',
    },
  ],
});

function matchesConditions(conditions, context) {
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

function resolveTierPercentage(rule, baseAmount) {
  if (!Array.isArray(rule.tiers) || rule.tiers.length === 0) return rule.percentage;
  const value = fromMinor(baseAmount);
  const tier = rule.tiers
    .filter((entry) => value >= Number(entry.from ?? 0) && (entry.to == null || value <= Number(entry.to)))
    .sort((a, b) => Number(b.from ?? 0) - Number(a.from ?? 0))[0];
  return tier ? Number(tier.percentage) : rule.percentage;
}

function resolveRecipient(rule, context) {
  switch (rule.recipient_type) {
    case 'agent':
      return { membership_id: rule.recipient_ref ?? context.agentMembershipId ?? null };
    case 'manager':
      return { membership_id: rule.recipient_ref ?? context.managerMembershipId ?? null };
    case 'team_leader':
      return { membership_id: rule.recipient_ref ?? context.teamLeaderMembershipId ?? null };
    case 'referral_partner':
      return { contact_id: rule.recipient_ref ?? context.referralContactId ?? null };
    case 'external_broker':
      return { contact_id: rule.recipient_ref ?? context.externalBrokerContactId ?? null };
    case 'branch':
    case 'company':
    default:
      return {};
  }
}

/**
 * Validates a commission plan's rules before they are stored. Percentage lines charged
 * against the gross base must total exactly 100 unless fixed or residual lines are used.
 */
export function validateCommissionRules(rules) {
  const issues = [];
  if (!Array.isArray(rules) || rules.length === 0) {
    issues.push({ path: 'rules', message: 'At least one commission line is required' });
    return issues;
  }

  const grossPercentage = rules
    .filter((rule) => rule.calculation_type === 'percentage' && (rule.applies_to ?? 'gross') === 'gross')
    .reduce((total, rule) => total + Number(rule.percentage ?? 0), 0);
  const hasFixed = rules.some((rule) => rule.calculation_type === 'fixed');
  const hasRemaining = rules.some((rule) => (rule.applies_to ?? 'gross') === 'remaining');

  for (const rule of rules) {
    if (rule.calculation_type === 'percentage' && rule.percentage == null && !rule.tiers) {
      issues.push({ path: `rules[${rule.position}]`, message: 'Percentage line requires a percentage or tiers' });
    }
    if (rule.calculation_type === 'fixed' && rule.fixed_amount == null) {
      issues.push({ path: `rules[${rule.position}]`, message: 'Fixed line requires an amount' });
    }
    if (Number(rule.percentage ?? 0) < 0) {
      issues.push({ path: `rules[${rule.position}]`, message: 'Percentage cannot be negative' });
    }
  }

  if (!hasFixed && !hasRemaining && Math.abs(grossPercentage - 100) > 0.0001) {
    issues.push({
      path: 'rules',
      message: `Percentage splits must total 100% (currently ${grossPercentage}%)`,
    });
  }
  if (grossPercentage > 100.0001) {
    issues.push({ path: 'rules', message: `Percentage splits exceed 100% (${grossPercentage}%)` });
  }
  return issues;
}

/**
 * Calculates the commission split for a deal and returns an immutable snapshot payload.
 * The result is stored verbatim so later plan edits never rewrite historical commissions.
 */
export function calculateCommission({
  plan = DEFAULT_COMMISSION_PLAN,
  rules = plan.rules ?? [],
  deal,
  context = {},
  manualOverrides = [],
}) {
  const vatPercentage = Number(context.vatPercentage ?? 5);
  const commissionBase = plan.commission_base ?? 'gross_before_vat';

  const grossMinor = toMinor(deal.gross_commission ?? 0);
  if (grossMinor <= 0) {
    throw new ValidationError('Gross commission must be greater than zero to calculate splits');
  }
  const vatMinor = percentageOfMinor(grossMinor, vatPercentage);
  const costsMinor = toMinor(context.costs ?? 0);

  let baseMinor;
  switch (commissionBase) {
    case 'gross_after_vat':
      baseMinor = grossMinor + vatMinor;
      break;
    case 'net_after_costs':
      baseMinor = grossMinor - costsMinor;
      break;
    case 'gross_before_vat':
    default:
      baseMinor = grossMinor;
      break;
  }

  const conditionContext = {
    deal_type: deal.deal_type,
    module: deal.module,
    branch_id: deal.branch_id,
    team_id: deal.team_id,
    project_id: deal.project_id,
    source_id: context.sourceId ?? null,
    property_value: deal.property_value,
    ...context.conditionContext,
  };

  const applicable = [...rules]
    .filter((rule) => rule.is_active !== false)
    .filter((rule) => matchesConditions(rule.conditions, conditionContext))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const issues = validateCommissionRules(applicable);
  if (issues.length > 0) {
    throw new ValidationError('Commission plan is not valid for this deal', issues);
  }

  const lines = [];
  let allocatedMinor = 0;

  // 1. Fixed amount lines are taken off the base first.
  for (const rule of applicable.filter((entry) => entry.calculation_type === 'fixed')) {
    let amount = toMinor(rule.fixed_amount);
    if (rule.cap_amount != null) amount = Math.min(amount, toMinor(rule.cap_amount));
    allocatedMinor += amount;
    lines.push(buildLine(rule, amount, null, context, 'fixed'));
  }
  if (allocatedMinor > baseMinor) {
    throw new ValidationError('Fixed commission lines exceed the commission base', {
      base: fromMinor(baseMinor),
      fixed: fromMinor(allocatedMinor),
    });
  }

  // 2. Percentage lines charged against the full base.
  const grossPercentageRules = applicable.filter(
    (rule) => rule.calculation_type === 'percentage' && (rule.applies_to ?? 'gross') === 'gross'
  );
  const totalGrossPercentage = grossPercentageRules.reduce(
    (total, rule) => total + Number(resolveTierPercentage(rule, baseMinor) ?? 0),
    0
  );

  const remainderBase = baseMinor - allocatedMinor;
  const usesWholeBase =
    Math.abs(totalGrossPercentage - 100) < 0.0001 &&
    applicable.every((rule) => (rule.applies_to ?? 'gross') === 'gross' || rule.calculation_type === 'fixed');

  if (usesWholeBase && grossPercentageRules.length > 0) {
    // Exact split: largest remainder keeps the sum equal to the base to the cent.
    const weights = grossPercentageRules.map((rule) =>
      Math.round(Number(resolveTierPercentage(rule, baseMinor)) * 10_000)
    );
    const amounts = distributeMinor(remainderBase, weights);
    grossPercentageRules.forEach((rule, index) => {
      let amount = amounts[index];
      if (rule.cap_amount != null) amount = Math.min(amount, toMinor(rule.cap_amount));
      allocatedMinor += amount;
      lines.push(buildLine(rule, amount, resolveTierPercentage(rule, baseMinor), context, 'percentage'));
    });
  } else {
    for (const rule of grossPercentageRules) {
      const percentage = Number(resolveTierPercentage(rule, baseMinor));
      let amount = percentageOfMinor(baseMinor, percentage);
      if (rule.cap_amount != null) amount = Math.min(amount, toMinor(rule.cap_amount));
      allocatedMinor += amount;
      lines.push(buildLine(rule, amount, percentage, context, 'percentage'));
    }
  }

  // 3. Percentage lines charged against whatever is left.
  for (const rule of applicable.filter(
    (entry) => entry.calculation_type === 'percentage' && (entry.applies_to ?? 'gross') === 'remaining'
  )) {
    const percentage = Number(resolveTierPercentage(rule, baseMinor));
    const remaining = Math.max(baseMinor - allocatedMinor, 0);
    let amount = percentageOfMinor(remaining, percentage);
    if (rule.cap_amount != null) amount = Math.min(amount, toMinor(rule.cap_amount));
    allocatedMinor += amount;
    lines.push(buildLine(rule, amount, percentage, context, 'remaining'));
  }

  // 4. Manual overrides replace a calculated line and always require approval.
  for (const override of manualOverrides) {
    const index = lines.findIndex(
      (line) => line.recipient_type === override.recipient_type && line.membership_id === (override.membership_id ?? null)
    );
    const amount = toMinor(override.amount);
    const line = {
      recipient_type: override.recipient_type,
      membership_id: override.membership_id ?? null,
      contact_id: override.contact_id ?? null,
      label: override.label ?? `${override.recipient_type} override`,
      calculation_type: 'manual',
      percentage: null,
      amount: fromMinor(amount),
      is_manual_override: true,
      requires_approval: true,
      calculation_trace: { reason: override.reason ?? 'manual override' },
    };
    if (index >= 0) {
      allocatedMinor += amount - toMinor(lines[index].amount);
      lines[index] = line;
    } else {
      allocatedMinor += amount;
      lines.push(line);
    }
  }

  // 5. Any rounding residual settles on the company line so the split always balances.
  const residual = baseMinor - allocatedMinor;
  const warnings = [];
  if (residual !== 0) {
    const companyLine = lines.find((line) => line.recipient_type === 'company');
    if (companyLine) {
      companyLine.amount = fromMinor(toMinor(companyLine.amount) + residual);
      companyLine.calculation_trace = {
        ...companyLine.calculation_trace,
        residual_applied: fromMinor(residual),
      };
    } else {
      warnings.push({
        code: 'unallocated_residual',
        message: 'Commission lines do not consume the full base and no company line exists',
        amount: fromMinor(residual),
      });
    }
  }

  return {
    commission_base: commissionBase,
    base_amount: fromMinor(baseMinor),
    gross_commission: fromMinor(grossMinor),
    vat_amount: fromMinor(vatMinor),
    vat_percentage: vatPercentage,
    currency: deal.currency ?? 'AED',
    plan_code: plan.code ?? null,
    plan_version: plan.version ?? 1,
    lines,
    warnings,
    rules_snapshot: applicable,
    inputs_snapshot: {
      deal_id: deal.id ?? null,
      deal_type: deal.deal_type,
      property_value: deal.property_value ?? null,
      gross_commission: fromMinor(grossMinor),
      vat_percentage: vatPercentage,
      context: conditionContext,
      calculated_at: new Date().toISOString(),
    },
  };
}

function buildLine(rule, amountMinor, percentage, context, mode) {
  const recipient = resolveRecipient(rule, context);
  return {
    recipient_type: rule.recipient_type,
    membership_id: recipient.membership_id ?? null,
    contact_id: recipient.contact_id ?? null,
    label: rule.label ?? `${rule.recipient_type} share`,
    calculation_type: rule.calculation_type,
    percentage: percentage ?? null,
    amount: fromMinor(amountMinor),
    is_manual_override: false,
    requires_approval: Boolean(rule.requires_approval),
    calculation_trace: {
      mode,
      rule_position: rule.position ?? null,
      applies_to: rule.applies_to ?? 'gross',
      cap_amount: rule.cap_amount ?? null,
      tiers_used: Array.isArray(rule.tiers) && rule.tiers.length > 0,
    },
  };
}

/** Builds the reversing snapshot used when a deal is cancelled or amended. */
export function reverseCommissionSnapshot(snapshot) {
  return {
    ...snapshot,
    status: 'reversal',
    base_amount: -snapshot.base_amount,
    gross_commission: -snapshot.gross_commission,
    vat_amount: -snapshot.vat_amount,
    lines: snapshot.lines.map((line) => ({
      ...line,
      amount: -line.amount,
      calculation_trace: { ...line.calculation_trace, reversal_of: snapshot.id ?? null },
    })),
  };
}
