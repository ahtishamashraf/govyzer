import { getDb, withTransaction } from '@govyzer/database';
import {
  newId,
  newPairingCode,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  evaluatePointsRules,
  buildLeaderboard,
} from '@govyzer/domain';
import { loadServerConfig } from '@govyzer/config';
import { sha256 } from '../../core/crypto.js';
import { signDisplayToken } from '../../core/tokens.js';
import { recordAudit } from '../../core/audit.js';

function parse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Fields that must never reach a display, regardless of configuration. */
const FORBIDDEN_PAYLOAD_KEYS = ['phone', 'email', 'passport', 'emirates_id', 'address_line', 'contact_name', 'client_name', 'notes'];

export function sanitizeDisplayPayload(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !FORBIDDEN_PAYLOAD_KEYS.some((forbidden) => key.toLowerCase().includes(forbidden)))
  );
}

/**
 * Converts a domain event into a Sales Screen event and its points ledger entries.
 * Idempotent: the same source event never produces two celebrations or two point awards.
 */
export async function createSalesEvent({
  db = getDb(),
  organizationId,
  eventType,
  sourceEntityType,
  sourceEntityId,
  idempotencyKey,
  displayPayload = {},
  amount = null,
  currency = 'AED',
  membershipId = null,
  teamId = null,
  branchId = null,
  projectId = null,
  occurredAt = new Date(),
}) {
  const existing = await db('sales_events').where({ organization_id: organizationId, idempotency_key: idempotencyKey }).first();
  if (existing) return existing;

  const organizationSettings = await db('organizations').where('id', organizationId).first('settings');
  const settings = parse(organizationSettings?.settings, {}) ?? {};
  const autoApprove = settings.sales_screen?.auto_approve_events ?? true;

  const id = newId();
  await db('sales_events').insert({
    id,
    organization_id: organizationId,
    event_type: eventType,
    status: autoApprove ? 'approved' : 'pending',
    source_entity_type: sourceEntityType,
    source_entity_id: sourceEntityId,
    idempotency_key: idempotencyKey,
    branch_id: branchId,
    team_id: teamId,
    project_id: projectId,
    membership_id: membershipId,
    display_payload: JSON.stringify(sanitizeDisplayPayload(displayPayload)),
    amount,
    currency,
    occurred_at: occurredAt,
    approved_at: autoApprove ? db.fn.now() : null,
  });

  if (!autoApprove) {
    await db('sales_event_approvals').insert({
      id: newId(),
      organization_id: organizationId,
      sales_event_id: id,
      status: 'pending',
    });
  }

  const points = await awardPoints({
    db,
    organizationId,
    eventType,
    membershipId,
    teamId,
    branchId,
    sourceEntityType,
    sourceEntityId,
    salesEventId: id,
    amount,
    context: displayPayload,
    occurredAt,
  });
  if (points.total !== 0) {
    await db('sales_events').where('id', id).update({ points_awarded: points.total });
  }

  await bumpFeedVersion({ db, organizationId });
  return db('sales_events').where('id', id).first();
}

/** Writes points ledger rows from the tenant's rules. Reversal-safe and idempotent. */
export async function awardPoints({
  db = getDb(),
  organizationId,
  eventType,
  membershipId,
  teamId = null,
  branchId = null,
  sourceEntityType,
  sourceEntityId,
  salesEventId = null,
  amount = 0,
  context = {},
  occurredAt = new Date(),
}) {
  if (!membershipId) return { total: 0, entries: [] };

  const rules = await db('points_rules')
    .where({ organization_id: organizationId, event_type: eventType, is_active: true })
    .whereNull('deleted_at');
  if (rules.length === 0) return { total: 0, entries: [] };

  const evaluated = evaluatePointsRules({
    eventType,
    rules: rules.map((rule) => ({ ...rule, conditions: parse(rule.conditions, {}) })),
    context: { ...context, occurredAt },
    amount: Number(amount ?? 0),
  });

  const entries = [];
  for (const entry of evaluated) {
    const idempotencyKey = `${sourceEntityType}:${sourceEntityId}:${entry.rule_code}`;
    const exists = await db('points_ledger').where({ organization_id: organizationId, idempotency_key: idempotencyKey }).first('id');
    if (exists) continue;
    const id = newId();
    await db('points_ledger').insert({
      id,
      organization_id: organizationId,
      membership_id: membershipId,
      team_id: teamId,
      branch_id: branchId,
      rule_id: rules.find((rule) => rule.code === entry.rule_code)?.id ?? null,
      rule_code: entry.rule_code,
      rule_version: entry.rule_version,
      event_type: eventType,
      source_entity_type: sourceEntityType,
      source_entity_id: sourceEntityId,
      sales_event_id: salesEventId,
      points: entry.points,
      idempotency_key: idempotencyKey,
      occurred_at: occurredAt,
    });
    entries.push({ id, ...entry });
  }
  return { total: entries.reduce((sum, entry) => sum + entry.points, 0), entries };
}

/** Reverses every points entry produced by a source entity (cancelled deal, for example). */
export async function reversePointsFor({ db = getDb(), organizationId, sourceEntityType, sourceEntityId, reason }) {
  const entries = await db('points_ledger')
    .where({ organization_id: organizationId, source_entity_type: sourceEntityType, source_entity_id: sourceEntityId })
    .whereNull('reverses_entry_id');

  for (const entry of entries) {
    const idempotencyKey = `reversal:${entry.id}`;
    const exists = await db('points_ledger').where({ organization_id: organizationId, idempotency_key: idempotencyKey }).first('id');
    if (exists) continue;
    await db('points_ledger').insert({
      id: newId(),
      organization_id: organizationId,
      membership_id: entry.membership_id,
      team_id: entry.team_id,
      branch_id: entry.branch_id,
      rule_id: entry.rule_id,
      rule_code: entry.rule_code,
      rule_version: entry.rule_version,
      event_type: entry.event_type,
      source_entity_type: sourceEntityType,
      source_entity_id: sourceEntityId,
      points: -Number(entry.points),
      idempotency_key: idempotencyKey,
      reverses_entry_id: entry.id,
      occurred_at: db.fn.now(),
    });
  }

  await db('sales_events')
    .where({ organization_id: organizationId, source_entity_type: sourceEntityType, source_entity_id: sourceEntityId })
    .update({ status: 'reversed', reversed_at: db.fn.now() });
  await bumpFeedVersion({ db, organizationId });
  return { reversed: entries.length, reason };
}

export async function bumpFeedVersion({ db = getDb(), organizationId }) {
  await db('sales_displays').where('organization_id', organizationId).increment('feed_version', 1);
}

// ---------------------------------------------------------------- pairing ----

export async function createDisplay({ organizationId, actor, payload }) {
  const db = getDb();
  const id = newId();
  const playlistId =
    payload.playlist_id ??
    (await db('display_playlists').where({ organization_id: organizationId, is_default: true }).first('id'))?.id ??
    null;

  await db('sales_displays').insert({
    id,
    organization_id: organizationId,
    ...payload,
    playlist_id: playlistId,
    theme_overrides: payload.theme_overrides ? JSON.stringify(payload.theme_overrides) : null,
    privacy_settings: JSON.stringify(payload.privacy_settings ?? { mask_agent_names: false, mask_amounts: false, hide_exact_address: true, show_client_initials_only: true }),
    filters: payload.filters ? JSON.stringify(payload.filters) : null,
    status: 'unpaired',
    created_by: actor.membershipId,
    updated_by: actor.membershipId,
  });
  await recordAudit({ organizationId, actor, action: 'display.created', entityType: 'sales_display', entityId: id, after: { name: payload.name } });
  return db('sales_displays').where('id', id).first();
}

/** Issues a short-lived, single-use pairing code. Only its hash is stored. */
export async function issuePairingCode({ organizationId, actor, displayId }) {
  const db = getDb();
  const { env } = loadServerConfig();
  const display = await db('sales_displays').where({ id: displayId, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!display) throw new NotFoundError('Display');

  await db('display_pairing_codes')
    .where({ organization_id: organizationId, display_id: displayId })
    .whereNull('consumed_at')
    .update({ expires_at: db.fn.now() });

  const code = newPairingCode(8);
  const expiresAt = new Date(Date.now() + env.DISPLAY_PAIRING_CODE_TTL_SECONDS * 1000);
  await db('display_pairing_codes').insert({
    id: newId(),
    organization_id: organizationId,
    display_id: displayId,
    code_hash: sha256(code),
    code_prefix: code.slice(0, 4),
    expires_at: expiresAt,
    created_by_membership_id: actor.membershipId,
  });
  await db('sales_displays').where('id', displayId).update({ status: 'pairing', updated_at: db.fn.now() });

  await recordAudit({ organizationId, actor, action: 'display.pairing_code_issued', entityType: 'sales_display', entityId: displayId });
  return {
    code,
    expires_at: expiresAt,
    pairing_url: `${env.SALES_SCREEN_PUBLIC_URL}/pair?code=${code}`,
    ttl_seconds: env.DISPLAY_PAIRING_CODE_TTL_SECONDS,
  };
}

/**
 * Exchanges a pairing code for a display-scoped session. Rate limited and single use;
 * the resulting token can only read the display feed and post heartbeats.
 */
export async function claimPairingCode({ code, deviceFingerprint = null, appVersion = null, ip = null, userAgent = null }) {
  const db = getDb();
  const { env } = loadServerConfig();
  const record = await db('display_pairing_codes').where('code_hash', sha256(code)).first();

  if (!record) throw new UnauthorizedError('That pairing code is not valid');
  if (record.consumed_at) throw new ConflictError('That pairing code has already been used');
  if (new Date(record.expires_at) < new Date()) throw new UnauthorizedError('That pairing code has expired');

  const display = await db('sales_displays').where('id', record.display_id).whereNull('deleted_at').first();
  if (!display || display.revoked_at) throw new UnauthorizedError('This display is no longer available');

  return withTransaction(db, async (trx) => {
    const consumed = await trx('display_pairing_codes').where({ id: record.id }).whereNull('consumed_at').update({ consumed_at: trx.fn.now() });
    if (consumed === 0) throw new ConflictError('That pairing code has already been used');

    const sessionId = newId();
    const token = signDisplayToken({ displayId: display.id, organizationId: display.organization_id, sessionId });
    await trx('display_sessions').insert({
      id: sessionId,
      organization_id: display.organization_id,
      display_id: display.id,
      token_hash: sha256(token),
      expires_at: new Date(Date.now() + env.DISPLAY_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      ip_address: ip,
      user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
      last_seen_at: trx.fn.now(),
    });
    await trx('display_pairing_codes').where('id', record.id).update({ consumed_by_display_session_id: sessionId });
    await trx('sales_displays').where('id', display.id).update({
      status: 'paired',
      paired_at: trx.fn.now(),
      last_seen_at: trx.fn.now(),
      device_fingerprint: deviceFingerprint,
      app_version: appVersion,
      updated_at: trx.fn.now(),
    });

    return {
      display: { id: display.id, name: display.name, theme: display.theme, orientation: display.orientation },
      token,
      expires_at: new Date(Date.now() + env.DISPLAY_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      poll_interval_seconds: env.DISPLAY_FEED_POLL_SECONDS,
    };
  });
}

export async function revokeDisplay({ organizationId, actor, displayId, reason = 'revoked by admin' }) {
  const db = getDb();
  const display = await db('sales_displays').where({ id: displayId, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!display) throw new NotFoundError('Display');

  await withTransaction(db, async (trx) => {
    await trx('display_sessions').where({ organization_id: organizationId, display_id: displayId }).whereNull('revoked_at').update({ revoked_at: trx.fn.now(), revoked_reason: reason });
    await trx('display_pairing_codes').where({ organization_id: organizationId, display_id: displayId }).whereNull('consumed_at').update({ expires_at: trx.fn.now() });
    await trx('sales_displays').where('id', displayId).update({
      status: 'revoked',
      revoked_at: trx.fn.now(),
      revoked_by_membership_id: actor.membershipId,
      updated_at: trx.fn.now(),
    });
  });
  await recordAudit({ organizationId, actor, action: 'display.revoked', entityType: 'sales_display', entityId: displayId, after: { reason } });
  return db('sales_displays').where('id', displayId).first();
}

export async function heartbeat({ organizationId, displayId, sessionId, appVersion = null }) {
  const db = getDb();
  await db('display_sessions').where({ id: sessionId, organization_id: organizationId }).update({ last_seen_at: db.fn.now() });
  await db('sales_displays').where({ id: displayId, organization_id: organizationId }).update({
    last_seen_at: db.fn.now(),
    ...(appVersion ? { app_version: appVersion } : {}),
  });
  const display = await db('sales_displays').where('id', displayId).first('feed_version');
  return { ok: true, feed_version: Number(display?.feed_version ?? 1) };
}

// ------------------------------------------------------------------ feed ----

function periodRange(range = 'month') {
  const now = new Date();
  const start = new Date(now);
  switch (range) {
    case 'today':
      start.setUTCHours(0, 0, 0, 0);
      break;
    case 'week':
      start.setUTCDate(now.getUTCDate() - 7);
      break;
    case 'quarter':
      start.setUTCMonth(now.getUTCMonth() - 3);
      break;
    case 'year':
      start.setUTCMonth(0, 1);
      start.setUTCHours(0, 0, 0, 0);
      break;
    case 'month':
    default:
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      break;
  }
  return { start, end: now };
}

function maskName(name, privacy) {
  if (!name) return null;
  if (!privacy.mask_agent_names) return name;
  return name
    .split(' ')
    .map((part) => `${part.charAt(0).toUpperCase()}.`)
    .join(' ');
}

function maskAmount(amount, privacy) {
  if (amount == null) return null;
  return privacy.mask_amounts ? null : Number(amount);
}

/** Builds the complete, privacy-filtered payload one display renders. */
export async function buildDisplayFeed({ organizationId, displayId }) {
  const db = getDb();
  const display = await db('sales_displays').where({ id: displayId, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!display) throw new NotFoundError('Display');

  const privacy = parse(display.privacy_settings, {}) ?? {};
  const filters = parse(display.filters, {}) ?? {};
  const branding = await db('organization_branding').where('organization_id', organizationId).first();
  const organization = await db('organizations').where('id', organizationId).first('name', 'default_currency', 'timezone');
  const { start, end } = periodRange(filters.date_range ?? 'month');

  const slides = display.playlist_id
    ? await db('display_slides').where({ organization_id: organizationId, playlist_id: display.playlist_id, is_enabled: true }).orderBy('position')
    : [];

  const scopeDeals = (query) => {
    let builder = query.where('deals.organization_id', organizationId).whereNull('deals.deleted_at').where('deals.status', 'won');
    if (filters.branch_ids?.length) builder = builder.whereIn('deals.branch_id', filters.branch_ids);
    if (filters.team_ids?.length) builder = builder.whereIn('deals.team_id', filters.team_ids);
    if (filters.project_ids?.length) builder = builder.whereIn('deals.project_id', filters.project_ids);
    if (filters.modules?.length) builder = builder.whereIn('deals.module', filters.modules);
    return builder.where('deals.won_at', '>=', start).where('deals.won_at', '<=', end);
  };

  const [events, revenueRow, dealCountRow, listingCountRow, topAgents, topTeams, topDeals, stockRows, reservationCountRow, pointsRows, targets, announcements] =
    await Promise.all([
      db('sales_events')
        .where({ organization_id: organizationId, status: 'approved' })
        .whereNull('reversed_at')
        .where('occurred_at', '>=', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .orderBy('occurred_at', 'desc')
        .limit(30),
      scopeDeals(db('deals')).sum({ revenue: 'gross_commission' }).sum({ value: 'property_value' }).first(),
      scopeDeals(db('deals')).count({ total: 'deals.id' }).first(),
      db('listings').where('organization_id', organizationId).whereNull('deleted_at').whereIn('status', ['published', 'partially_published']).count({ total: 'id' }).first(),
      scopeDeals(
        db('deals')
          .leftJoin('organization_memberships as m', 'm.id', 'deals.agent_membership_id')
          .leftJoin('users as u', 'u.id', 'm.user_id')
      )
        .groupBy('deals.agent_membership_id', 'u.first_name', 'u.last_name', 'u.avatar_url')
        .select('deals.agent_membership_id', 'u.first_name', 'u.last_name', 'u.avatar_url')
        .sum({ revenue: 'deals.gross_commission' })
        .count({ deals: 'deals.id' })
        .orderBy('revenue', 'desc')
        .limit(10),
      scopeDeals(db('deals').leftJoin('teams as t', 't.id', 'deals.team_id'))
        .groupBy('deals.team_id', 't.name')
        .select('deals.team_id', 't.name as team_name')
        .sum({ revenue: 'deals.gross_commission' })
        .count({ deals: 'deals.id' })
        .orderBy('revenue', 'desc')
        .limit(10),
      scopeDeals(
        db('deals')
          .leftJoin('organization_memberships as m', 'm.id', 'deals.agent_membership_id')
          .leftJoin('users as u', 'u.id', 'm.user_id')
      )
        .select('deals.id', 'deals.reference', 'deals.property_value', 'deals.gross_commission', 'deals.currency', 'deals.won_at', 'deals.deal_type', 'u.first_name', 'u.last_name')
        .orderBy('deals.property_value', 'desc')
        .limit(5),
      db('units').where('organization_id', organizationId).whereNull('deleted_at').groupBy('stock_status').select('stock_status').count({ total: 'id' }).sum({ value: 'current_price' }),
      db('reservations').where('organization_id', organizationId).whereNull('deleted_at').whereIn('status', ['pending', 'confirmed', 'extended']).count({ total: 'id' }).first(),
      db('points_ledger')
        .where('organization_id', organizationId)
        .where('occurred_at', '>=', start)
        .select('membership_id', 'team_id', 'points'),
      db('targets').where({ organization_id: organizationId, is_active: true }).whereNull('deleted_at').where('period_start', '<=', end).where('period_end', '>=', start),
      db('announcements')
        .where({ organization_id: organizationId, status: 'scheduled' })
        .whereNull('deleted_at')
        .where('starts_at', '<=', new Date())
        .where((builder) => builder.whereNull('ends_at').orWhere('ends_at', '>=', new Date()))
        .orderBy('priority')
        .limit(10),
    ]);

  const leaderboard = buildLeaderboard(pointsRows, { groupBy: 'membership_id', limit: 10 });
  const membershipIds = leaderboard.map((row) => row.key);
  const leaderboardNames = membershipIds.length
    ? await db('organization_memberships as m').join('users as u', 'u.id', 'm.user_id').whereIn('m.id', membershipIds).select('m.id', 'u.first_name', 'u.last_name', 'u.avatar_url')
    : [];
  const nameMap = new Map(leaderboardNames.map((row) => [row.id, row]));

  const revenue = Number(revenueRow?.revenue ?? 0);
  const revenueTarget = targets.find((target) => target.target_type === 'revenue' && target.scope_type === 'organization');

  return {
    display: {
      id: display.id,
      name: display.name,
      theme: display.theme,
      theme_overrides: parse(display.theme_overrides, null),
      orientation: display.orientation,
      slide_duration_seconds: display.slide_duration_seconds,
      transition: display.transition,
      feed_version: Number(display.feed_version ?? 1),
    },
    branding: branding
      ? {
          company_display_name: branding.company_display_name,
          logo_light_url: branding.logo_light_url,
          logo_dark_url: branding.logo_dark_url,
          primary_color: branding.primary_color,
          accent_color: branding.accent_color,
          font_family: branding.font_family,
          sales_screen_theme: branding.sales_screen_theme,
        }
      : null,
    organization: { name: organization?.name, currency: organization?.default_currency, timezone: organization?.timezone },
    period: { range: filters.date_range ?? 'month', start, end },
    slides: slides.map((slide) => ({
      id: slide.id,
      type: slide.slide_type,
      title: slide.title,
      duration_seconds: slide.duration_seconds ?? display.slide_duration_seconds,
      config: parse(slide.config, {}),
    })),
    metrics: {
      revenue: maskAmount(revenue, privacy),
      property_value: maskAmount(Number(revenueRow?.value ?? 0), privacy),
      deal_count: Number(dealCountRow?.total ?? 0),
      listing_count: Number(listingCountRow?.total ?? 0),
      active_reservations: Number(reservationCountRow?.total ?? 0),
      stock: stockRows.map((row) => ({ status: row.stock_status, count: Number(row.total), value: maskAmount(Number(row.value ?? 0), privacy) })),
      target: revenueTarget
        ? {
            value: Number(revenueTarget.target_value),
            achieved: revenue,
            percentage: Number(revenueTarget.target_value) > 0 ? Math.min(Math.round((revenue / Number(revenueTarget.target_value)) * 100), 999) : 0,
            period_end: revenueTarget.period_end,
          }
        : null,
    },
    top_agents: topAgents.map((row) => ({
      membership_id: row.agent_membership_id,
      name: maskName(`${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(), privacy),
      avatar_url: privacy.mask_agent_names ? null : row.avatar_url,
      revenue: maskAmount(Number(row.revenue ?? 0), privacy),
      deals: Number(row.deals ?? 0),
    })),
    top_teams: topTeams.map((row) => ({ team_id: row.team_id, name: row.team_name, revenue: maskAmount(Number(row.revenue ?? 0), privacy), deals: Number(row.deals ?? 0) })),
    top_deals: topDeals.map((row) => ({
      reference: row.reference,
      deal_type: row.deal_type,
      property_value: maskAmount(Number(row.property_value ?? 0), privacy),
      currency: row.currency,
      agent_name: maskName(`${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(), privacy),
      won_at: row.won_at,
    })),
    points_leaderboard: leaderboard.map((row) => ({
      rank: row.rank,
      membership_id: row.key,
      name: maskName(`${nameMap.get(row.key)?.first_name ?? ''} ${nameMap.get(row.key)?.last_name ?? ''}`.trim(), privacy),
      avatar_url: privacy.mask_agent_names ? null : nameMap.get(row.key)?.avatar_url ?? null,
      points: row.points,
    })),
    events: events.map((event) => ({
      id: event.id,
      type: event.event_type,
      occurred_at: event.occurred_at,
      points: event.points_awarded,
      amount: maskAmount(event.amount, privacy),
      currency: event.currency,
      payload: sanitizeDisplayPayload(parse(event.display_payload, {})),
    })),
    announcements: announcements.map((announcement) => ({
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      type: announcement.announcement_type,
      media_url: announcement.media_url,
      duration_seconds: announcement.duration_seconds,
    })),
    generated_at: new Date().toISOString(),
  };
}

export async function approveSalesEvent({ organizationId, actor, eventId, decision, reason }) {
  const db = getDb();
  const event = await db('sales_events').where({ id: eventId, organization_id: organizationId }).first();
  if (!event) throw new NotFoundError('Sales event');

  await db('sales_events').where('id', event.id).update({
    status: decision === 'approved' ? 'approved' : 'rejected',
    approved_at: decision === 'approved' ? db.fn.now() : null,
    approved_by_membership_id: actor.membershipId,
  });
  await db('sales_event_approvals')
    .where({ organization_id: organizationId, sales_event_id: event.id, status: 'pending' })
    .update({ status: decision, decided_by_membership_id: actor.membershipId, decided_at: db.fn.now(), decision_reason: reason ?? null });
  await bumpFeedVersion({ db, organizationId });
  return db('sales_events').where('id', event.id).first();
}
