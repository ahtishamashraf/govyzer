import { getDb, withTransaction } from '@govyzer/database';
import {
  newId,
  NotFoundError,
  ValidationError,
  ConflictError,
  buildLeadStageMachine,
} from '@govyzer/domain';
import { nextReference } from '../../core/references.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';
import { recordAudit } from '../../core/audit.js';
import { findOrCreateContact } from '../contacts/service.js';
import { assignLead } from './assignment.js';
import { scheduleSla } from './sla.js';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function loadStageDefinitions({ trx, organizationId, pipeline }) {
  const db = trx ?? getDb();
  const rows = await db('lead_stage_definitions')
    .where({ organization_id: organizationId, pipeline, is_active: true })
    .whereNull('deleted_at')
    .orderBy('position');
  return rows.map((row) => ({ ...row, name: parseJson(row.name, { en: row.code }) }));
}

/**
 * Creates a lead. The contact identity is deduplicated first, so a repeat enquiry from a
 * known phone number produces a new lead on the existing contact rather than being lost.
 */
export async function createLead({ organizationId, actor, payload, source = 'manual', request = {} }) {
  const db = getDb();

  const created = await withTransaction(db, async (trx) => {
    let contactId = payload.contact_id ?? null;
    let contactResult = null;
    if (!contactId) {
      if (!payload.contact) throw new ValidationError('Either contact_id or contact details are required');
      contactResult = await findOrCreateContact({
        trx,
        organizationId,
        actor,
        payload: { ...payload.contact, roles: payload.contact.roles?.length ? payload.contact.roles : defaultRoleFor(payload.purpose) },
        source,
      });
      contactId = contactResult.contact.id;
    } else {
      const contact = await trx('contacts').where({ id: contactId, organization_id: organizationId }).whereNull('deleted_at').first();
      if (!contact) throw new NotFoundError('Contact');
      contactResult = { contact, created: false };
    }

    const pipeline = payload.pipeline ?? payload.module ?? 'ready';
    const stages = await loadStageDefinitions({ trx, organizationId, pipeline });
    const entryStage = stages.find((stage) => stage.is_default_entry) ?? stages[0];
    const stageCode = payload.stage_code ?? entryStage?.code ?? 'new_inquiry';

    const reference = await nextReference({ trx, organizationId, entity: 'lead', prefix: actor?.referencePrefix ?? 'GVZ' });
    const id = newId();

    let sourceId = payload.source_id ?? null;
    if (!sourceId && payload.source_code) {
      const sourceRow = await trx('lead_sources').where({ organization_id: organizationId, code: payload.source_code }).first('id');
      sourceId = sourceRow?.id ?? null;
    }

    await trx('leads').insert({
      id,
      organization_id: organizationId,
      reference,
      contact_id: contactId,
      module: payload.module ?? 'ready',
      purpose: payload.purpose ?? 'buy',
      pipeline,
      stage_code: stageCode,
      status: 'open',
      priority: payload.priority ?? 'normal',
      source_id: sourceId,
      campaign_id: payload.campaign_id ?? null,
      portal_code: payload.portal_code ?? null,
      external_lead_id: payload.external_lead_id ?? null,
      utm: payload.utm ? JSON.stringify(payload.utm) : null,
      listing_id: payload.listing_id ?? null,
      project_id: payload.project_id ?? null,
      unit_id: payload.unit_id ?? null,
      property_reference: payload.property_reference ?? null,
      language: payload.language ?? 'en',
      estimated_value: payload.estimated_value ?? null,
      financing: payload.financing ?? null,
      timeframe: payload.timeframe ?? null,
      notes: payload.notes ?? null,
      referred_by_contact_id: payload.referred_by_contact_id ?? null,
      provider_payload: payload.provider_payload ? JSON.stringify(payload.provider_payload) : null,
      created_by: actor?.membershipId ?? null,
      updated_by: actor?.membershipId ?? null,
      last_activity_at: trx.fn.now(),
    });

    const requirements = payload.requirements?.length
      ? payload.requirements
      : buildImplicitRequirement(payload);
    if (requirements.length > 0) {
      await trx('lead_requirements').insert(
        requirements.map((requirement) => ({
          id: newId(),
          organization_id: organizationId,
          lead_id: id,
          purpose: requirement.purpose ?? payload.purpose ?? 'buy',
          module: requirement.module ?? payload.module ?? 'ready',
          property_types: requirement.property_types ? JSON.stringify(requirement.property_types) : null,
          bedrooms_min: requirement.bedrooms_min ?? null,
          bedrooms_max: requirement.bedrooms_max ?? null,
          bathrooms_min: requirement.bathrooms_min ?? null,
          budget_min: requirement.budget_min ?? null,
          budget_max: requirement.budget_max ?? null,
          currency: requirement.currency ?? 'AED',
          size_min: requirement.size_min ?? null,
          size_max: requirement.size_max ?? null,
          size_unit: requirement.size_unit ?? 'sqft',
          community_ids: requirement.community_ids ? JSON.stringify(requirement.community_ids) : null,
          city_ids: requirement.city_ids ? JSON.stringify(requirement.city_ids) : null,
          amenities: requirement.amenities ? JSON.stringify(requirement.amenities) : null,
          views: requirement.views ? JSON.stringify(requirement.views) : null,
          handover_from: requirement.handover_from ?? null,
          handover_to: requirement.handover_to ?? null,
          move_in_from: requirement.move_in_from ?? null,
          payment_plan_preference: requirement.payment_plan_preference ?? null,
          furnishing: requirement.furnishing ?? null,
          rent_frequency: requirement.rent_frequency ?? null,
          notes: requirement.notes ?? null,
          is_active: true,
        }))
      );
    }

    if (payload.tags?.length) await attachTags({ trx, organizationId, leadId: id, tags: payload.tags });

    await trx('lead_stage_history').insert({
      id: newId(),
      organization_id: organizationId,
      lead_id: id,
      from_stage_code: null,
      to_stage_code: stageCode,
      changed_by_membership_id: actor?.membershipId ?? null,
      reason: 'lead created',
      source,
    });

    const lead = await trx('leads').where('id', id).first();

    if (payload.assigned_membership_id) {
      await assignLead({ trx, organizationId, lead, actor, manualMembershipId: payload.assigned_membership_id, reason: 'assigned at creation' });
    } else if (payload.auto_assign !== false) {
      await assignLead({ trx, organizationId, lead, actor });
    }

    const assigned = await trx('leads').where('id', id).first();
    if (assigned.assigned_membership_id) await scheduleSla({ trx, organizationId, lead: assigned });

    if (lead.listing_id) {
      await trx('listings').where({ id: lead.listing_id, organization_id: organizationId }).increment('lead_count', 1);
    }

    await emitEvent(trx, {
      organizationId,
      eventType: EVENT_TYPES.LEAD_CREATED,
      aggregateType: 'lead',
      aggregateId: id,
      payload: {
        lead_id: id,
        reference,
        module: assigned.module,
        stage_code: assigned.stage_code,
        source,
        contact_id: contactId,
        assigned_membership_id: assigned.assigned_membership_id,
      },
    });

    return { lead: assigned, contact: contactResult.contact, contact_deduplicated: contactResult.created === false };
  });

  await recordAudit({
    organizationId,
    actor,
    action: 'lead.created',
    entityType: 'lead',
    entityId: created.lead.id,
    after: { reference: created.lead.reference, module: created.lead.module, source },
    requestId: request.requestId,
    source,
  });
  return created;
}

function defaultRoleFor(purpose) {
  switch (purpose) {
    case 'rent':
      return ['tenant'];
    case 'sell':
      return ['seller'];
    case 'lease_out':
      return ['landlord'];
    case 'invest':
      return ['investor'];
    default:
      return ['buyer'];
  }
}

function buildImplicitRequirement(payload) {
  const hasSignal = payload.estimated_value || payload.budget_min || payload.budget_max || payload.bedrooms;
  if (!hasSignal) return [];
  return [
    {
      purpose: payload.purpose ?? 'buy',
      module: payload.module ?? 'ready',
      budget_min: payload.budget_min ?? null,
      budget_max: payload.budget_max ?? payload.estimated_value ?? null,
      bedrooms_min: payload.bedrooms ?? null,
      bedrooms_max: payload.bedrooms ?? null,
    },
  ];
}

async function attachTags({ trx, organizationId, leadId, tags }) {
  for (const name of tags) {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
    let tag = await trx('tags').where({ organization_id: organizationId, entity_type: 'lead', slug }).first();
    if (!tag) {
      const id = newId();
      await trx('tags').insert({ id, organization_id: organizationId, name, slug, entity_type: 'lead' });
      tag = { id };
    }
    await trx('lead_tags')
      .insert({ lead_id: leadId, tag_id: tag.id, organization_id: organizationId })
      .onConflict(['lead_id', 'tag_id'])
      .ignore();
  }
}

export async function getLead({ organizationId, id }) {
  const db = getDb();
  const lead = await db('leads').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!lead) throw new NotFoundError('Lead');

  const [contact, requirements, stageHistory, assignmentHistory, tasks, meetings, viewings, notes, slaEvents] = await Promise.all([
    db('contacts').where({ id: lead.contact_id, organization_id: organizationId }).first('id', 'reference', 'display_name', 'preferred_language', 'do_not_contact'),
    db('lead_requirements').where({ organization_id: organizationId, lead_id: id }).whereNull('deleted_at'),
    db('lead_stage_history').where({ organization_id: organizationId, lead_id: id }).orderBy('created_at', 'desc').limit(50),
    db('lead_assignment_history').where({ organization_id: organizationId, lead_id: id }).orderBy('created_at', 'desc').limit(20),
    db('tasks').where({ organization_id: organizationId, entity_type: 'lead', entity_id: id }).whereNull('deleted_at').orderBy('due_at'),
    db('meetings').where({ organization_id: organizationId, lead_id: id }).whereNull('deleted_at').orderBy('starts_at', 'desc'),
    db('viewings').where({ organization_id: organizationId, lead_id: id }).whereNull('deleted_at').orderBy('scheduled_at', 'desc'),
    db('notes').where({ organization_id: organizationId, entity_type: 'lead', entity_id: id }).whereNull('deleted_at').orderBy('created_at', 'desc').limit(50),
    db('lead_sla_events').where({ organization_id: organizationId, lead_id: id }).orderBy('due_at'),
  ]);

  return {
    ...lead,
    utm: parseJson(lead.utm, null),
    contact,
    requirements: requirements.map((requirement) => ({
      ...requirement,
      property_types: parseJson(requirement.property_types, []),
      community_ids: parseJson(requirement.community_ids, []),
      amenities: parseJson(requirement.amenities, []),
      views: parseJson(requirement.views, []),
    })),
    stage_history: stageHistory,
    assignment_history: assignmentHistory.map((row) => ({
      ...row,
      evaluated_rules: parseJson(row.evaluated_rules, []),
      candidates: parseJson(row.candidates, []),
    })),
    tasks,
    meetings,
    viewings,
    notes,
    sla_events: slaEvents,
  };
}

export async function updateLead({ organizationId, actor, id, payload, request = {} }) {
  const db = getDb();
  const before = await db('leads').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!before) throw new NotFoundError('Lead');

  const { requirements, tags, version, stage_code: stageCode, ...rest } = payload;
  const updates = { ...rest, updated_by: actor.membershipId, updated_at: db.fn.now(), last_activity_at: db.fn.now() };
  if (rest.utm) updates.utm = JSON.stringify(rest.utm);
  Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

  await withTransaction(db, async (trx) => {
    let query = trx('leads').where({ id, organization_id: organizationId });
    if (version != null) query = query.where('version', version);
    const updated = await query.update({ ...updates, version: trx.raw('`version` + 1') });
    if (updated === 0) throw new ConflictError('This lead was changed by someone else. Reload and try again.');

    if (requirements) {
      await trx('lead_requirements').where({ organization_id: organizationId, lead_id: id }).update({ deleted_at: trx.fn.now() });
      if (requirements.length > 0) {
        await trx('lead_requirements').insert(
          requirements.map((requirement) => ({
            id: newId(),
            organization_id: organizationId,
            lead_id: id,
            purpose: requirement.purpose ?? before.purpose,
            module: requirement.module ?? before.module,
            property_types: requirement.property_types ? JSON.stringify(requirement.property_types) : null,
            bedrooms_min: requirement.bedrooms_min ?? null,
            bedrooms_max: requirement.bedrooms_max ?? null,
            budget_min: requirement.budget_min ?? null,
            budget_max: requirement.budget_max ?? null,
            currency: requirement.currency ?? 'AED',
            size_min: requirement.size_min ?? null,
            size_max: requirement.size_max ?? null,
            size_unit: requirement.size_unit ?? 'sqft',
            community_ids: requirement.community_ids ? JSON.stringify(requirement.community_ids) : null,
            amenities: requirement.amenities ? JSON.stringify(requirement.amenities) : null,
            handover_from: requirement.handover_from ?? null,
            handover_to: requirement.handover_to ?? null,
            notes: requirement.notes ?? null,
            is_active: true,
          }))
        );
      }
    }
    if (tags) await attachTags({ trx, organizationId, leadId: id, tags });
    if (stageCode && stageCode !== before.stage_code) {
      await applyStageChange({ trx, organizationId, actor, lead: before, stageCode, reason: 'updated with lead' });
    }
  });

  const after = await db('leads').where('id', id).first();
  await recordAudit({ organizationId, actor, action: 'lead.updated', entityType: 'lead', entityId: id, before, after, requestId: request.requestId });
  await emitEvent(db, {
    organizationId,
    eventType: EVENT_TYPES.LEAD_UPDATED,
    aggregateType: 'lead',
    aggregateId: id,
    payload: { lead_id: id, changed_fields: Object.keys(updates) },
  });
  return after;
}

export async function applyStageChange({ trx, organizationId, actor, lead, stageCode, reason = null, lossReason = null }) {
  const stages = await loadStageDefinitions({ trx, organizationId, pipeline: lead.pipeline });
  const machine = buildLeadStageMachine(stages);
  machine.assert(lead.stage_code, stageCode);

  const target = stages.find((stage) => stage.code === stageCode);
  if (!target) throw new ValidationError(`Unknown stage ${stageCode}`);

  const requiredFields = parseJson(target.required_fields, []) ?? [];
  const missing = requiredFields.filter((field) => lead[field] == null || lead[field] === '');
  if (missing.length > 0) {
    throw new ValidationError(`This stage requires: ${missing.join(', ')}`, missing.map((field) => ({ path: field, message: 'Required for this stage' })));
  }

  const previousChange = await trx('lead_stage_history')
    .where({ organization_id: organizationId, lead_id: lead.id })
    .orderBy('created_at', 'desc')
    .first('created_at');
  const durationSeconds = previousChange
    ? Math.max(Math.round((Date.now() - new Date(previousChange.created_at).getTime()) / 1000), 0)
    : null;

  const updates = {
    stage_code: stageCode,
    status: target.category === 'open' ? 'open' : target.category,
    updated_at: trx.fn.now(),
    last_activity_at: trx.fn.now(),
    updated_by: actor?.membershipId ?? null,
  };
  if (target.category === 'won') updates.won_at = trx.fn.now();
  if (target.category === 'lost' || target.category === 'junk') {
    updates.lost_at = trx.fn.now();
    updates.loss_reason = lossReason ?? reason ?? null;
  }
  await trx('leads').where({ id: lead.id, organization_id: organizationId }).update(updates);

  await trx('lead_stage_history').insert({
    id: newId(),
    organization_id: organizationId,
    lead_id: lead.id,
    from_stage_code: lead.stage_code,
    to_stage_code: stageCode,
    changed_by_membership_id: actor?.membershipId ?? null,
    reason,
    duration_seconds: durationSeconds,
    source: actor ? 'user' : 'system',
  });

  await emitEvent(trx, {
    organizationId,
    eventType: EVENT_TYPES.LEAD_STAGE_CHANGED,
    aggregateType: 'lead',
    aggregateId: lead.id,
    payload: { lead_id: lead.id, from: lead.stage_code, to: stageCode, category: target.category },
  });
  return trx('leads').where('id', lead.id).first();
}

export async function changeStage({ organizationId, actor, id, stageCode, reason, lossReason }) {
  const db = getDb();
  const lead = await db('leads').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!lead) throw new NotFoundError('Lead');
  const updated = await withTransaction(db, (trx) => applyStageChange({ trx, organizationId, actor, lead, stageCode, reason, lossReason }));
  await recordAudit({ organizationId, actor, action: 'lead.stage_changed', entityType: 'lead', entityId: id, before: { stage_code: lead.stage_code }, after: { stage_code: stageCode } });
  return updated;
}

export async function acknowledgeLead({ organizationId, id }) {
  const db = getDb();
  const lead = await db('leads').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!lead) throw new NotFoundError('Lead');
  await db('leads').where('id', id).update({
    acknowledged_at: lead.acknowledged_at ?? db.fn.now(),
    first_response_at: lead.first_response_at ?? db.fn.now(),
    sla_status: 'met',
    last_activity_at: db.fn.now(),
  });
  await db('lead_sla_events').where({ organization_id: organizationId, lead_id: id, status: 'scheduled' }).update({ status: 'resolved', resolved_at: db.fn.now() });
  return db('leads').where('id', id).first();
}

export async function releaseToPool({ organizationId, actor, id, reason, eligibleMembershipIds = null, expiresAt = null }) {
  const db = getDb();
  return withTransaction(db, async (trx) => {
    const lead = await trx('leads').where({ id, organization_id: organizationId }).whereNull('deleted_at').forUpdate().first();
    if (!lead) throw new NotFoundError('Lead');
    if (lead.is_in_pool) throw new ConflictError('This lead is already in the pool');

    await trx('lead_pool_entries').insert({
      id: newId(),
      organization_id: organizationId,
      lead_id: id,
      status: 'available',
      released_by_membership_id: actor.membershipId,
      release_reason: reason ?? null,
      eligible_membership_ids: eligibleMembershipIds ? JSON.stringify(eligibleMembershipIds) : null,
      expires_at: expiresAt ?? null,
    });
    await trx('lead_assignments').where({ organization_id: organizationId, lead_id: id, is_active: true }).update({ is_active: false, unassigned_at: trx.fn.now() });
    await trx('leads').where('id', id).update({ is_in_pool: true, assigned_membership_id: null, updated_at: trx.fn.now() });
    await recordAudit({ organizationId, actor, action: 'lead.released_to_pool', entityType: 'lead', entityId: id, after: { reason }, trx });
    return trx('leads').where('id', id).first();
  });
}

/**
 * Claims a pooled lead. The conditional update is the concurrency guard: exactly one
 * agent can flip the entry from available to claimed.
 */
export async function claimFromPool({ organizationId, actor, id }) {
  const db = getDb();
  return withTransaction(db, async (trx) => {
    const entry = await trx('lead_pool_entries')
      .where({ organization_id: organizationId, lead_id: id, status: 'available' })
      .orderBy('released_at', 'desc')
      .first();
    if (!entry) throw new ConflictError('This lead is no longer available in the pool');

    const eligible = parseJson(entry.eligible_membership_ids, null);
    if (Array.isArray(eligible) && eligible.length > 0 && !eligible.includes(actor.membershipId)) {
      throw new ConflictError('This lead is reserved for another group of agents');
    }
    if (entry.expires_at && new Date(entry.expires_at) < new Date()) {
      await trx('lead_pool_entries').where('id', entry.id).update({ status: 'expired' });
      throw new ConflictError('This pool entry has expired');
    }

    const claimed = await trx('lead_pool_entries')
      .where({ id: entry.id, status: 'available' })
      .update({ status: 'claimed', claimed_by_membership_id: actor.membershipId, claimed_at: trx.fn.now() });
    if (claimed === 0) throw new ConflictError('Another agent claimed this lead first');

    const lead = await trx('leads').where({ id, organization_id: organizationId }).first();
    await assignLead({ trx, organizationId, lead, actor, manualMembershipId: actor.membershipId, reason: 'claimed from pool' });
    await trx('leads').where('id', id).update({ is_in_pool: false, updated_at: trx.fn.now() });
    await scheduleSla({ trx, organizationId, lead: await trx('leads').where('id', id).first() });
    await recordAudit({ organizationId, actor, action: 'lead.claimed', entityType: 'lead', entityId: id, trx });
    return trx('leads').where('id', id).first();
  });
}

export async function assign({ organizationId, actor, id, membershipId, reason }) {
  const db = getDb();
  const lead = await db('leads').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!lead) throw new NotFoundError('Lead');
  const decision = await withTransaction(db, (trx) =>
    assignLead({ trx, organizationId, lead, actor, manualMembershipId: membershipId ?? null, reason })
  );
  await recordAudit({
    organizationId,
    actor,
    action: 'lead.assigned',
    entityType: 'lead',
    entityId: id,
    before: { assigned_membership_id: lead.assigned_membership_id },
    after: { assigned_membership_id: decision.membershipId, reason: decision.reason },
  });
  return { lead: await db('leads').where('id', id).first(), decision };
}
