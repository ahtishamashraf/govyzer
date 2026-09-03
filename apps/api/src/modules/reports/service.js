import { getDb } from '@govyzer/database';
import { newId, NotFoundError, ForbiddenError, buildLeaderboard } from '@govyzer/domain';
import { applyRecordScope } from '../../core/repository.js';
import { putObject, isStorageConfigured, buildStorageKey, createDownloadUrl } from '../../core/storage.js';

function range(filters = {}) {
  const to = filters.to ? new Date(filters.to) : new Date();
  const from = filters.from ? new Date(filters.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

function scoped(query, actor, options) {
  return actor?.permissions?.has?.('reports.read_organization') || actor?.isPlatformAdmin
    ? query
    : applyRecordScope(query, actor, options);
}

/**
 * Allowlisted report definitions. Natural-language reporting resolves to one of these —
 * no model generated SQL ever reaches the database.
 */
export const REPORTS = Object.freeze({
  lead_source_conversion: {
    name: 'Lead source and conversion',
    category: 'leads',
    permission: 'reports.read',
    dimensions: ['source', 'module'],
    metrics: ['leads', 'won', 'lost', 'conversion_rate'],
    async run(db, { organizationId, filters, actor }) {
      const { from, to } = range(filters);
      const rows = await scoped(
        db('leads').leftJoin('lead_sources as s', 's.id', 'leads.source_id'),
        actor,
        { table: 'leads', assignedColumn: 'assigned_membership_id' }
      )
        .where('leads.organization_id', organizationId)
        .whereNull('leads.deleted_at')
        .whereBetween('leads.created_at', [from, to])
        .groupBy('s.code', 's.name', 'leads.module')
        .select('s.code as source_code', 's.name as source_name', 'leads.module')
        .count({ leads: 'leads.id' })
        .sum({ won: db.raw('CASE WHEN leads.status = "won" THEN 1 ELSE 0 END') })
        .sum({ lost: db.raw('CASE WHEN leads.status = "lost" THEN 1 ELSE 0 END') })
        .sum({ pipeline_value: 'leads.estimated_value' });
      return rows.map((row) => ({
        source: row.source_name ?? row.source_code ?? 'unknown',
        module: row.module,
        leads: Number(row.leads),
        won: Number(row.won ?? 0),
        lost: Number(row.lost ?? 0),
        pipeline_value: Number(row.pipeline_value ?? 0),
        conversion_rate: Number(row.leads) > 0 ? Math.round((Number(row.won ?? 0) / Number(row.leads)) * 1000) / 10 : 0,
      }));
    },
  },

  lead_response_time: {
    name: 'Lead response time',
    category: 'leads',
    permission: 'reports.read',
    metrics: ['avg_response_minutes', 'sla_met_rate'],
    async run(db, { organizationId, filters, actor }) {
      const { from, to } = range(filters);
      const rows = await scoped(
        db('leads').leftJoin('organization_memberships as m', 'm.id', 'leads.assigned_membership_id').leftJoin('users as u', 'u.id', 'm.user_id'),
        actor,
        { table: 'leads', assignedColumn: 'assigned_membership_id' }
      )
        .where('leads.organization_id', organizationId)
        .whereNull('leads.deleted_at')
        .whereBetween('leads.created_at', [from, to])
        .groupBy('leads.assigned_membership_id', 'u.first_name', 'u.last_name')
        .select('leads.assigned_membership_id', 'u.first_name', 'u.last_name')
        .count({ leads: 'leads.id' })
        .avg({ avg_response_minutes: db.raw('TIMESTAMPDIFF(MINUTE, leads.created_at, leads.first_response_at)') })
        .sum({ responded: db.raw('CASE WHEN leads.first_response_at IS NOT NULL THEN 1 ELSE 0 END') })
        .sum({ sla_met: db.raw('CASE WHEN leads.sla_status = "met" THEN 1 ELSE 0 END') });
      return rows.map((row) => ({
        membership_id: row.assigned_membership_id,
        agent: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || 'Unassigned',
        leads: Number(row.leads),
        responded: Number(row.responded ?? 0),
        avg_response_minutes: row.avg_response_minutes == null ? null : Math.round(Number(row.avg_response_minutes)),
        sla_met_rate: Number(row.leads) > 0 ? Math.round((Number(row.sla_met ?? 0) / Number(row.leads)) * 1000) / 10 : 0,
      }));
    },
  },

  assignment_fairness: {
    name: 'Assignment fairness',
    category: 'leads',
    permission: 'reports.read_organization',
    async run(db, { organizationId, filters }) {
      const { from, to } = range(filters);
      const rows = await db('lead_assignment_history as h')
        .leftJoin('organization_memberships as m', 'm.id', 'h.selected_membership_id')
        .leftJoin('users as u', 'u.id', 'm.user_id')
        .where('h.organization_id', organizationId)
        .whereBetween('h.created_at', [from, to])
        .groupBy('h.selected_membership_id', 'u.first_name', 'u.last_name', 'h.strategy')
        .select('h.selected_membership_id', 'u.first_name', 'u.last_name', 'h.strategy')
        .count({ assignments: 'h.id' })
        .sum({ manual: db.raw('CASE WHEN h.is_manual_override = 1 THEN 1 ELSE 0 END') });
      return rows.map((row) => ({
        membership_id: row.selected_membership_id,
        agent: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || 'Unassigned',
        strategy: row.strategy,
        assignments: Number(row.assignments),
        manual_overrides: Number(row.manual ?? 0),
      }));
    },
  },

  agent_performance: {
    name: 'Agent performance',
    category: 'sales',
    permission: 'reports.read',
    async run(db, { organizationId, filters, actor }) {
      const { from, to } = range(filters);
      const deals = await scoped(
        db('deals').leftJoin('organization_memberships as m', 'm.id', 'deals.agent_membership_id').leftJoin('users as u', 'u.id', 'm.user_id'),
        actor,
        { table: 'deals', assignedColumn: 'agent_membership_id' }
      )
        .where('deals.organization_id', organizationId)
        .whereNull('deals.deleted_at')
        .whereBetween('deals.created_at', [from, to])
        .groupBy('deals.agent_membership_id', 'u.first_name', 'u.last_name')
        .select('deals.agent_membership_id', 'u.first_name', 'u.last_name')
        .count({ deals: 'deals.id' })
        .sum({ won: db.raw('CASE WHEN deals.status = "won" THEN 1 ELSE 0 END') })
        .sum({ revenue: db.raw('CASE WHEN deals.status = "won" THEN deals.gross_commission ELSE 0 END') })
        .sum({ property_value: db.raw('CASE WHEN deals.status = "won" THEN deals.property_value ELSE 0 END') });
      return deals.map((row) => ({
        membership_id: row.agent_membership_id,
        agent: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || 'Unknown',
        deals: Number(row.deals),
        won: Number(row.won ?? 0),
        revenue: Number(row.revenue ?? 0),
        property_value: Number(row.property_value ?? 0),
      }));
    },
  },

  listings_by_status: {
    name: 'Listings by status',
    category: 'ready',
    permission: 'reports.read',
    async run(db, { organizationId, actor }) {
      const rows = await scoped(db('listings'), actor, { table: 'listings', assignedColumn: 'primary_agent_membership_id' })
        .where('listings.organization_id', organizationId)
        .whereNull('listings.deleted_at')
        .groupBy('listings.status', 'listings.offering_type')
        .select('listings.status', 'listings.offering_type')
        .count({ total: 'listings.id' })
        .sum({ value: 'listings.price' });
      return rows.map((row) => ({ status: row.status, offering_type: row.offering_type, listings: Number(row.total), total_value: Number(row.value ?? 0) }));
    },
  },

  listings_by_portal: {
    name: 'Listings by portal',
    category: 'ready',
    permission: 'reports.read',
    async run(db, { organizationId }) {
      const rows = await db('portal_publications as p')
        .join('portal_accounts as a', 'a.id', 'p.portal_account_id')
        .where('p.organization_id', organizationId)
        .whereNull('p.deleted_at')
        .groupBy('a.name', 'p.provider_code', 'p.status')
        .select('a.name as account_name', 'p.provider_code', 'p.status')
        .count({ total: 'p.id' });
      return rows.map((row) => ({ account: row.account_name, provider: row.provider_code, status: row.status, publications: Number(row.total) }));
    },
  },

  portal_errors: {
    name: 'Portal errors',
    category: 'ready',
    permission: 'reports.read',
    async run(db, { organizationId, filters }) {
      const { from, to } = range(filters);
      const rows = await db('portal_publications as p')
        .join('listings as l', 'l.id', 'p.listing_id')
        .where('p.organization_id', organizationId)
        .whereIn('p.status', ['failed', 'rejected'])
        .whereBetween('p.updated_at', [from, to])
        .groupBy('p.provider_code', 'p.last_error_code')
        .select('p.provider_code', 'p.last_error_code')
        .count({ total: 'p.id' });
      return rows.map((row) => ({ provider: row.provider_code, error_code: row.last_error_code ?? 'unknown', occurrences: Number(row.total) }));
    },
  },

  inventory_stock: {
    name: 'Off-plan inventory and stock',
    category: 'offplan',
    permission: 'reports.read',
    async run(db, { organizationId, filters }) {
      let query = db('units as u').leftJoin('projects as p', 'p.id', 'u.project_id').where('u.organization_id', organizationId).whereNull('u.deleted_at');
      if (filters.project_id) query = query.where('u.project_id', filters.project_id);
      const rows = await query
        .groupBy('p.name', 'u.stock_status')
        .select('p.name as project', 'u.stock_status')
        .count({ total: 'u.id' })
        .sum({ value: 'u.current_price' });
      return rows.map((row) => ({ project: row.project ?? 'Unassigned', status: row.stock_status, units: Number(row.total), value: Number(row.value ?? 0) }));
    },
  },

  meetings_viewings: {
    name: 'Meetings and viewings',
    category: 'activity',
    permission: 'reports.read',
    async run(db, { organizationId, filters, actor }) {
      const { from, to } = range(filters);
      const meetings = await scoped(db('meetings'), actor, { table: 'meetings', assignedColumn: 'organizer_membership_id' })
        .where('meetings.organization_id', organizationId)
        .whereNull('meetings.deleted_at')
        .whereBetween('meetings.starts_at', [from, to])
        .groupBy('meetings.status', 'meetings.module')
        .select('meetings.status', 'meetings.module')
        .count({ total: 'meetings.id' });
      const viewings = await db('viewings')
        .where('organization_id', organizationId)
        .whereNull('deleted_at')
        .whereBetween('scheduled_at', [from, to])
        .groupBy('status')
        .select('status')
        .count({ total: 'id' });
      return [
        ...meetings.map((row) => ({ type: 'meeting', module: row.module, status: row.status, total: Number(row.total) })),
        ...viewings.map((row) => ({ type: 'viewing', module: null, status: row.status, total: Number(row.total) })),
      ];
    },
  },

  reservations_bookings: {
    name: 'Reservations and bookings',
    category: 'offplan',
    permission: 'reports.read',
    async run(db, { organizationId, filters }) {
      const { from, to } = range(filters);
      const rows = await db('reservations as r')
        .leftJoin('projects as p', 'p.id', 'r.project_id')
        .where('r.organization_id', organizationId)
        .whereNull('r.deleted_at')
        .whereBetween('r.created_at', [from, to])
        .groupBy('p.name', 'r.status')
        .select('p.name as project', 'r.status')
        .count({ total: 'r.id' })
        .sum({ value: 'r.unit_price' });
      return rows.map((row) => ({ project: row.project ?? 'Unassigned', status: row.status, reservations: Number(row.total), value: Number(row.value ?? 0) }));
    },
  },

  revenue: {
    name: 'Revenue',
    category: 'finance',
    permission: 'reports.read',
    async run(db, { organizationId, filters, actor }) {
      const { from, to } = range(filters);
      const rows = await scoped(db('deals'), actor, { table: 'deals', assignedColumn: 'agent_membership_id' })
        .where('deals.organization_id', organizationId)
        .whereNull('deals.deleted_at')
        .where('deals.status', 'won')
        .whereBetween('deals.won_at', [from, to])
        .groupByRaw('DATE_FORMAT(deals.won_at, "%Y-%m"), deals.module, deals.deal_type')
        .select(db.raw('DATE_FORMAT(deals.won_at, "%Y-%m") as period'), 'deals.module', 'deals.deal_type')
        .count({ deals: 'deals.id' })
        .sum({ revenue: 'deals.gross_commission' })
        .sum({ property_value: 'deals.property_value' });
      return rows.map((row) => ({
        period: row.period,
        module: row.module,
        deal_type: row.deal_type,
        deals: Number(row.deals),
        revenue: Number(row.revenue ?? 0),
        property_value: Number(row.property_value ?? 0),
      }));
    },
  },

  commission: {
    name: 'Commission',
    category: 'finance',
    permission: 'commissions.read',
    async run(db, { organizationId, filters }) {
      const { from, to } = range(filters);
      const rows = await db('commission_lines as cl')
        .leftJoin('organization_memberships as m', 'm.id', 'cl.membership_id')
        .leftJoin('users as u', 'u.id', 'm.user_id')
        .where('cl.organization_id', organizationId)
        .whereBetween('cl.created_at', [from, to])
        .groupBy('cl.recipient_type', 'cl.membership_id', 'u.first_name', 'u.last_name', 'cl.status')
        .select('cl.recipient_type', 'cl.membership_id', 'u.first_name', 'u.last_name', 'cl.status')
        .sum({ amount: 'cl.amount' })
        .count({ lines: 'cl.id' });
      return rows.map((row) => ({
        recipient_type: row.recipient_type,
        recipient: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || row.recipient_type,
        status: row.status,
        lines: Number(row.lines),
        amount: Number(row.amount ?? 0),
      }));
    },
  },

  ai_usage: {
    name: 'AI usage',
    category: 'platform',
    permission: 'ai.manage',
    async run(db, { organizationId }) {
      const rows = await db('ai_usage_ledger').where('organization_id', organizationId).orderBy('period', 'desc').limit(200);
      return rows.map((row) => ({
        period: row.period,
        feature: row.feature,
        model: row.model,
        requests: Number(row.request_count),
        prompt_tokens: Number(row.prompt_tokens),
        completion_tokens: Number(row.completion_tokens),
        estimated_cost: Number(row.estimated_cost ?? 0),
      }));
    },
  },

  integration_health: {
    name: 'Integration health',
    category: 'platform',
    permission: 'integrations.read',
    async run(db, { organizationId }) {
      const connections = await db('integration_connections').where('organization_id', organizationId).whereNull('deleted_at').select('provider', 'name', 'status', 'health_status', 'last_success_at', 'consecutive_failures');
      const portals = await db('portal_accounts').where('organization_id', organizationId).whereNull('deleted_at').select('provider_code as provider', 'name', 'status', 'health_status', 'last_success_at');
      return [...connections, ...portals.map((row) => ({ ...row, consecutive_failures: null }))];
    },
  },

  sales_points: {
    name: 'Sales Screen points',
    category: 'sales_screen',
    permission: 'sales_screen.read',
    async run(db, { organizationId, filters }) {
      const { from, to } = range(filters);
      const rows = await db('points_ledger')
        .where('organization_id', organizationId)
        .whereBetween('occurred_at', [from, to])
        .select('membership_id', 'team_id', 'branch_id', 'points', 'rule_code');
      const leaderboard = buildLeaderboard(rows, { groupBy: 'membership_id', limit: 50 });
      const names = leaderboard.length
        ? await db('organization_memberships as m').join('users as u', 'u.id', 'm.user_id').whereIn('m.id', leaderboard.map((row) => row.key)).select('m.id', 'u.first_name', 'u.last_name')
        : [];
      const nameMap = new Map(names.map((row) => [row.id, `${row.first_name} ${row.last_name}`.trim()]));
      return leaderboard.map((row) => ({ rank: row.rank, membership_id: row.key, agent: nameMap.get(row.key) ?? 'Unknown', points: row.points }));
    },
  },
});

export function listReports(actor) {
  return Object.entries(REPORTS)
    .filter(([, definition]) => actor?.isPlatformAdmin || actor?.permissions?.has?.(definition.permission) || definition.permission === 'reports.read')
    .map(([code, definition]) => ({ code, name: definition.name, category: definition.category, metrics: definition.metrics ?? [], dimensions: definition.dimensions ?? [] }));
}

export async function runReport({ organizationId, code, filters = {}, actor }) {
  const definition = REPORTS[code];
  if (!definition) throw new NotFoundError('Report');
  if (!actor?.isPlatformAdmin && definition.permission && !actor?.permissions?.has?.(definition.permission)) {
    throw new ForbiddenError(`Missing permission: ${definition.permission}`);
  }
  const db = getDb();
  const rows = await definition.run(db, { organizationId, filters, actor });
  return { code, name: definition.name, filters, rows, generated_at: new Date().toISOString() };
}

// -------------------------------------------------------------- dashboards ----

export async function executiveDashboard({ organizationId, actor, filters = {} }) {
  const db = getDb();
  const { from, to } = range(filters);
  const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));

  const wonQuery = (start, end) =>
    scoped(db('deals'), actor, { table: 'deals', assignedColumn: 'agent_membership_id' })
      .where('deals.organization_id', organizationId)
      .whereNull('deals.deleted_at')
      .where('deals.status', 'won')
      .whereBetween('deals.won_at', [start, end]);

  const [current, previous, leads, listings, units, reservations, topAgents] = await Promise.all([
    wonQuery(from, to).sum({ revenue: 'deals.gross_commission' }).count({ deals: 'deals.id' }).first(),
    wonQuery(previousFrom, from).sum({ revenue: 'deals.gross_commission' }).count({ deals: 'deals.id' }).first(),
    scoped(db('leads'), actor, { table: 'leads', assignedColumn: 'assigned_membership_id' })
      .where('leads.organization_id', organizationId)
      .whereNull('leads.deleted_at')
      .whereBetween('leads.created_at', [from, to])
      .count({ total: 'leads.id' })
      .sum({ won: db.raw('CASE WHEN leads.status = "won" THEN 1 ELSE 0 END') })
      .first(),
    db('listings').where('organization_id', organizationId).whereNull('deleted_at').groupBy('status').select('status').count({ total: 'id' }),
    db('units').where('organization_id', organizationId).whereNull('deleted_at').groupBy('stock_status').select('stock_status').count({ total: 'id' }).sum({ value: 'current_price' }),
    db('reservations').where('organization_id', organizationId).whereNull('deleted_at').whereIn('status', ['pending', 'confirmed', 'extended']).count({ total: 'id' }).first(),
    runReport({ organizationId, code: 'agent_performance', filters, actor }).then((report) => report.rows.sort((a, b) => b.revenue - a.revenue).slice(0, 5)),
  ]);

  const revenue = Number(current?.revenue ?? 0);
  const previousRevenue = Number(previous?.revenue ?? 0);

  return {
    period: { from, to },
    revenue: {
      value: revenue,
      previous: previousRevenue,
      change_percentage: previousRevenue > 0 ? Math.round(((revenue - previousRevenue) / previousRevenue) * 1000) / 10 : null,
    },
    deals: { value: Number(current?.deals ?? 0), previous: Number(previous?.deals ?? 0) },
    leads: { total: Number(leads?.total ?? 0), won: Number(leads?.won ?? 0) },
    listings: listings.map((row) => ({ status: row.status, total: Number(row.total) })),
    stock: units.map((row) => ({ status: row.stock_status, total: Number(row.total), value: Number(row.value ?? 0) })),
    active_reservations: Number(reservations?.total ?? 0),
    top_agents: topAgents,
  };
}

export async function readyDashboard({ organizationId, actor, filters = {} }) {
  const db = getDb();
  const { from, to } = range(filters);
  const [byStatus, portalErrors, leads, viewings, revenue] = await Promise.all([
    runReport({ organizationId, code: 'listings_by_status', filters, actor }),
    runReport({ organizationId, code: 'portal_errors', filters, actor }),
    scoped(db('leads'), actor, { table: 'leads', assignedColumn: 'assigned_membership_id' })
      .where('leads.organization_id', organizationId)
      .where('leads.module', 'ready')
      .whereNull('leads.deleted_at')
      .whereBetween('leads.created_at', [from, to])
      .count({ total: 'leads.id' })
      .avg({ avg_response: db.raw('TIMESTAMPDIFF(MINUTE, leads.created_at, leads.first_response_at)') })
      .first(),
    db('viewings').where('organization_id', organizationId).whereNull('deleted_at').whereBetween('scheduled_at', [from, to]).count({ total: 'id' }).first(),
    scoped(db('deals'), actor, { table: 'deals', assignedColumn: 'agent_membership_id' })
      .where('deals.organization_id', organizationId)
      .where('deals.module', 'ready')
      .where('deals.status', 'won')
      .whereBetween('deals.won_at', [from, to])
      .sum({ revenue: 'deals.gross_commission' })
      .count({ deals: 'deals.id' })
      .first(),
  ]);

  return {
    period: { from, to },
    listings_by_status: byStatus.rows,
    portal_errors: portalErrors.rows,
    leads: { total: Number(leads?.total ?? 0), avg_response_minutes: leads?.avg_response == null ? null : Math.round(Number(leads.avg_response)) },
    viewings: Number(viewings?.total ?? 0),
    revenue: Number(revenue?.revenue ?? 0),
    deals: Number(revenue?.deals ?? 0),
  };
}

export async function offplanDashboard({ organizationId, actor, filters = {} }) {
  const db = getDb();
  const { from, to } = range(filters);
  const [stock, reservations, leads, upcomingExpiries, projects] = await Promise.all([
    runReport({ organizationId, code: 'inventory_stock', filters, actor }),
    runReport({ organizationId, code: 'reservations_bookings', filters, actor }),
    scoped(db('leads'), actor, { table: 'leads', assignedColumn: 'assigned_membership_id' })
      .where('leads.organization_id', organizationId)
      .where('leads.module', 'offplan')
      .whereNull('leads.deleted_at')
      .whereBetween('leads.created_at', [from, to])
      .count({ total: 'leads.id' })
      .first(),
    db('reservations')
      .where('organization_id', organizationId)
      .whereNull('deleted_at')
      .whereIn('status', ['pending', 'confirmed', 'extended'])
      .where('expires_at', '<=', new Date(Date.now() + 72 * 60 * 60 * 1000))
      .orderBy('expires_at')
      .limit(20)
      .select('id', 'reference', 'unit_id', 'expires_at', 'agent_membership_id'),
    db('projects').where('organization_id', organizationId).whereNull('deleted_at').count({ total: 'id' }).first(),
  ]);

  return {
    period: { from, to },
    stock: stock.rows,
    reservations: reservations.rows,
    leads: Number(leads?.total ?? 0),
    upcoming_expiries: upcomingExpiries,
    project_count: Number(projects?.total ?? 0),
  };
}

// ----------------------------------------------------------------- exports ----

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');
}

export async function createExport({ organizationId, actor, entityType, filters = {}, format = 'csv' }) {
  const db = getDb();
  const id = newId();
  await db('data_exports').insert({
    id,
    organization_id: organizationId,
    membership_id: actor.membershipId,
    entity_type: entityType,
    format,
    filters: JSON.stringify(filters),
    status: 'queued',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  const { enqueueJob } = await import('../../core/jobs.js');
  const { JOB_TYPES } = await import('../../jobs/index.js');
  await enqueueJob({ organizationId, jobType: JOB_TYPES.EXPORT_RUN, payload: { export_id: id }, dedupeKey: `export:${id}` });
  return db('data_exports').where('id', id).first();
}

const EXPORTABLE = {
  leads: (db, organizationId) => db('leads').where('organization_id', organizationId).whereNull('deleted_at'),
  contacts: (db, organizationId) => db('contacts').where('organization_id', organizationId).whereNull('deleted_at'),
  listings: (db, organizationId) => db('listings').where('organization_id', organizationId).whereNull('deleted_at'),
  units: (db, organizationId) => db('units').where('organization_id', organizationId).whereNull('deleted_at'),
  deals: (db, organizationId) => db('deals').where('organization_id', organizationId).whereNull('deleted_at'),
  reservations: (db, organizationId) => db('reservations').where('organization_id', organizationId).whereNull('deleted_at'),
};

export async function runExport({ db = getDb(), organizationId, exportId }) {
  const record = await db('data_exports').where({ id: exportId, organization_id: organizationId }).first();
  if (!record) return { skipped: true };

  const builder = EXPORTABLE[record.entity_type];
  if (!builder) {
    await db('data_exports').where('id', exportId).update({ status: 'failed', error_message: `Unsupported export entity ${record.entity_type}` });
    return { failed: true };
  }

  const rows = await builder(db, organizationId).limit(20_000);
  const csv = toCsv(rows);
  let storageKey = null;
  if (isStorageConfigured()) {
    storageKey = buildStorageKey({ organizationId, entityType: 'export', entityId: exportId, fileName: `${record.entity_type}.csv` });
    await putObject(storageKey, Buffer.from(csv, 'utf8'), 'text/csv');
  }
  await db('data_exports').where('id', exportId).update({
    status: 'completed',
    row_count: rows.length,
    storage_key: storageKey,
    completed_at: db.fn.now(),
    error_message: storageKey ? null : 'File storage is not configured; the export was generated but not stored.',
  });
  return { rows: rows.length, storage_key: storageKey };
}

export async function exportDownloadUrl({ organizationId, exportId }) {
  const db = getDb();
  const record = await db('data_exports').where({ id: exportId, organization_id: organizationId }).first();
  if (!record) throw new NotFoundError('Export');
  if (!record.storage_key) return { download_url: null, reason: record.error_message ?? 'Not ready' };
  return { download_url: await createDownloadUrl(record.storage_key, { fileName: `${record.entity_type}.csv` }), row_count: record.row_count };
}

export { toCsv };
