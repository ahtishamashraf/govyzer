import { getDb, withTransaction } from '@govyzer/database';
import { newId, normalizeIdentifier, ValidationError, NotFoundError, filterProtectedFields } from '@govyzer/domain';
import { nextReference } from '../../core/references.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';
import { recordAudit } from '../../core/audit.js';

function displayNameFrom(payload) {
  if (payload.display_name) return payload.display_name;
  const parts = [payload.first_name, payload.last_name].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return payload.company_name ?? 'Unnamed contact';
}

/**
 * Resolves an inbound enquiry to a contact. A repeat mobile number or email never causes
 * the enquiry to be discarded: the identity is deduplicated and the new enquiry is
 * attached to the existing contact.
 */
export async function findOrCreateContact({ trx, organizationId, actor = null, payload, source = 'manual' }) {
  const db = trx ?? getDb();
  const identifiers = (payload.identifiers ?? [])
    .map((identifier) => ({
      ...identifier,
      value_normalized: normalizeIdentifier(identifier.identifier_type, identifier.value),
    }))
    .filter((identifier) => identifier.value_normalized);

  let contact = null;
  let matchedOn = null;

  for (const identifier of identifiers) {
    const existing = await db('contact_identifiers')
      .where({
        organization_id: organizationId,
        identifier_type: identifier.identifier_type,
        value_normalized: identifier.value_normalized,
      })
      .whereNull('deleted_at')
      .first();
    if (existing) {
      contact = await db('contacts').where({ id: existing.contact_id, organization_id: organizationId }).whereNull('deleted_at').first();
      if (contact) {
        matchedOn = identifier.identifier_type;
        break;
      }
    }
  }

  if (contact) {
    // Attach any identifier we have not seen before to the existing identity.
    for (const identifier of identifiers) {
      const exists = await db('contact_identifiers')
        .where({ organization_id: organizationId, identifier_type: identifier.identifier_type, value_normalized: identifier.value_normalized })
        .first('id');
      if (!exists) {
        await db('contact_identifiers').insert({
          id: newId(),
          organization_id: organizationId,
          contact_id: contact.id,
          identifier_type: identifier.identifier_type,
          value_raw: identifier.value,
          value_normalized: identifier.value_normalized,
          label: identifier.label ?? source,
          is_primary: false,
        });
      }
    }
    await ensureRoles({ trx: db, organizationId, contactId: contact.id, roles: payload.roles ?? [] });
    return { contact, created: false, matched_on: matchedOn };
  }

  const reference = await nextReference({
    trx: db,
    organizationId,
    entity: 'contact',
    prefix: actor?.referencePrefix ?? 'GVZ',
  });
  const id = newId();
  await db('contacts').insert({
    id,
    organization_id: organizationId,
    reference,
    contact_type: payload.contact_type ?? 'individual',
    first_name: payload.first_name ?? null,
    last_name: payload.last_name ?? null,
    display_name: displayNameFrom(payload),
    company_name: payload.company_name ?? null,
    nationality: payload.nationality ?? null,
    preferred_language: payload.preferred_language ?? 'en',
    preferred_contact_method: payload.preferred_contact_method ?? 'phone',
    owner_membership_id: payload.owner_membership_id ?? actor?.membershipId ?? null,
    source_id: payload.source_id ?? null,
    do_not_contact: payload.do_not_contact ?? false,
    summary: payload.summary ?? null,
    created_by: actor?.membershipId ?? null,
    updated_by: actor?.membershipId ?? null,
  });

  if (identifiers.length > 0) {
    await db('contact_identifiers').insert(
      identifiers.map((identifier, index) => ({
        id: newId(),
        organization_id: organizationId,
        contact_id: id,
        identifier_type: identifier.identifier_type,
        value_raw: identifier.value,
        value_normalized: identifier.value_normalized,
        label: identifier.label ?? source,
        is_primary: identifier.is_primary ?? index === 0,
      }))
    );
  }
  await ensureRoles({ trx: db, organizationId, contactId: id, roles: payload.roles ?? [] });

  const contactRow = await db('contacts').where('id', id).first();
  await emitEvent(db, {
    organizationId,
    eventType: EVENT_TYPES.CONTACT_CREATED,
    aggregateType: 'contact',
    aggregateId: id,
    payload: { id, reference, display_name: contactRow.display_name, source },
  });
  return { contact: contactRow, created: true, matched_on: null };
}

/** A contact may hold several roles at once (buyer and landlord, for example). */
export async function ensureRoles({ trx, organizationId, contactId, roles = [] }) {
  const db = trx ?? getDb();
  if (roles.length === 0) return;
  const existing = new Set(await db('contact_roles').where({ organization_id: organizationId, contact_id: contactId }).pluck('role'));
  const missing = roles.filter((role) => !existing.has(role));
  if (missing.length === 0) return;
  await db('contact_roles').insert(
    missing.map((role) => ({
      id: newId(),
      organization_id: organizationId,
      contact_id: contactId,
      role,
      is_active: true,
    }))
  );
}

export async function getContact({ organizationId, id, actor }) {
  const db = getDb();
  const contact = await db('contacts').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!contact) throw new NotFoundError('Contact');

  const [identifiers, roles, addresses, consents, leads] = await Promise.all([
    db('contact_identifiers').where({ organization_id: organizationId, contact_id: id }).whereNull('deleted_at'),
    db('contact_roles').where({ organization_id: organizationId, contact_id: id }),
    db('contact_addresses').where({ organization_id: organizationId, contact_id: id }).whereNull('deleted_at'),
    db('contact_consents').where({ organization_id: organizationId, contact_id: id }),
    db('leads')
      .where({ organization_id: organizationId, contact_id: id })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .select('id', 'reference', 'module', 'purpose', 'stage_code', 'status', 'assigned_membership_id', 'created_at'),
  ]);

  return {
    ...contact,
    identifiers: identifiers.map((identifier) =>
      filterProtectedFields(actor, 'contact', {
        ...identifier,
        value_raw: maskIdentifier(actor, identifier),
      })
    ),
    roles: roles.map((role) => role.role),
    addresses,
    consents,
    leads,
  };
}

function maskIdentifier(actor, identifier) {
  if (actor?.isPlatformAdmin || actor?.permissions?.has('contacts.view_sensitive')) return identifier.value_raw;
  const value = String(identifier.value_raw ?? '');
  if (identifier.identifier_type === 'email') {
    const [name, domain] = value.split('@');
    return domain ? `${name.slice(0, 2)}***@${domain}` : '***';
  }
  return value.length > 4 ? `${'*'.repeat(Math.max(value.length - 4, 3))}${value.slice(-4)}` : '***';
}

export async function createContact({ organizationId, actor, payload, request = {} }) {
  const db = getDb();
  const result = await withTransaction(db, (trx) =>
    findOrCreateContact({ trx, organizationId, actor, payload, source: 'manual' })
  );
  await recordAudit({
    organizationId,
    actor,
    action: result.created ? 'contact.created' : 'contact.matched',
    entityType: 'contact',
    entityId: result.contact.id,
    after: { reference: result.contact.reference, display_name: result.contact.display_name },
    requestId: request.requestId,
  });
  return result;
}

export async function updateContact({ organizationId, actor, id, payload, request = {} }) {
  const db = getDb();
  const before = await db('contacts').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!before) throw new NotFoundError('Contact');

  const { identifiers, roles, version, ...rest } = payload;
  const updates = { ...rest, updated_by: actor.membershipId, updated_at: db.fn.now() };
  if (rest.first_name || rest.last_name || rest.company_name || rest.display_name) {
    updates.display_name = displayNameFrom({ ...before, ...rest });
  }
  Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

  await withTransaction(db, async (trx) => {
    let query = trx('contacts').where({ id, organization_id: organizationId });
    if (version != null) query = query.where('version', version);
    const updated = await query.update({ ...updates, version: trx.raw('`version` + 1') });
    if (updated === 0) {
      throw new ValidationError('This contact was changed by someone else. Reload and try again.');
    }
    if (roles) await ensureRoles({ trx, organizationId, contactId: id, roles });
    if (identifiers) {
      for (const identifier of identifiers) {
        const normalized = normalizeIdentifier(identifier.identifier_type, identifier.value);
        if (!normalized) continue;
        const owner = await trx('contact_identifiers')
          .where({ organization_id: organizationId, identifier_type: identifier.identifier_type, value_normalized: normalized })
          .first();
        if (owner && owner.contact_id !== id) {
          throw new ValidationError('That phone number or email already belongs to another contact', [
            { path: 'identifiers', message: `${identifier.value} is used by contact ${owner.contact_id}` },
          ]);
        }
        if (!owner) {
          await trx('contact_identifiers').insert({
            id: newId(),
            organization_id: organizationId,
            contact_id: id,
            identifier_type: identifier.identifier_type,
            value_raw: identifier.value,
            value_normalized: normalized,
            label: identifier.label ?? null,
            is_primary: identifier.is_primary ?? false,
          });
        }
      }
    }
  });

  const after = await db('contacts').where('id', id).first();
  await recordAudit({
    organizationId,
    actor,
    action: 'contact.updated',
    entityType: 'contact',
    entityId: id,
    before,
    after,
    requestId: request.requestId,
  });
  return after;
}

/** Merges two contacts, moving every related record and keeping a reversible history row. */
export async function mergeContacts({ organizationId, actor, sourceContactId, targetContactId, fieldChoices = {} }) {
  if (sourceContactId === targetContactId) throw new ValidationError('Cannot merge a contact into itself');
  const db = getDb();

  return withTransaction(db, async (trx) => {
    const source = await trx('contacts').where({ id: sourceContactId, organization_id: organizationId }).first();
    const target = await trx('contacts').where({ id: targetContactId, organization_id: organizationId }).first();
    if (!source || !target) throw new NotFoundError('Contact');

    await trx('contact_identifiers')
      .where({ organization_id: organizationId, contact_id: sourceContactId })
      .update({ contact_id: targetContactId, is_primary: false });

    const targetRoles = new Set(await trx('contact_roles').where({ organization_id: organizationId, contact_id: targetContactId }).pluck('role'));
    const sourceRoles = await trx('contact_roles').where({ organization_id: organizationId, contact_id: sourceContactId });
    for (const role of sourceRoles) {
      if (targetRoles.has(role.role)) await trx('contact_roles').where('id', role.id).delete();
      else await trx('contact_roles').where('id', role.id).update({ contact_id: targetContactId });
    }

    for (const table of ['leads', 'contact_addresses', 'contact_consents', 'notes', 'meetings', 'viewings', 'communication_threads', 'messages', 'unit_owners', 'reservations']) {
      const hasContactColumn = await trx.schema.hasColumn(table, 'contact_id');
      if (hasContactColumn) {
        await trx(table).where({ organization_id: organizationId, contact_id: sourceContactId }).update({ contact_id: targetContactId });
      }
    }

    const updates = {};
    for (const [field, choice] of Object.entries(fieldChoices)) {
      if (choice === 'source' && source[field] !== undefined) updates[field] = source[field];
    }
    if (Object.keys(updates).length > 0) {
      await trx('contacts').where('id', targetContactId).update({ ...updates, updated_at: trx.fn.now() });
    }

    await trx('contacts').where('id', sourceContactId).update({
      deleted_at: trx.fn.now(),
      merged_into_contact_id: targetContactId,
      status: 'merged',
    });
    await trx('contact_merge_history').insert({
      id: newId(),
      organization_id: organizationId,
      source_contact_id: sourceContactId,
      target_contact_id: targetContactId,
      merged_fields: JSON.stringify(fieldChoices),
      source_snapshot: JSON.stringify(source),
      merged_by_membership_id: actor.membershipId,
    });

    await recordAudit({
      organizationId,
      actor,
      action: 'contact.merged',
      entityType: 'contact',
      entityId: targetContactId,
      before: { source_contact_id: sourceContactId },
      after: { target_contact_id: targetContactId },
      trx,
    });

    return trx('contacts').where('id', targetContactId).first();
  });
}

/** Duplicate suggestions based on shared identifiers and near-identical display names. */
export async function findDuplicateCandidates({ organizationId, contactId }) {
  const db = getDb();
  const contact = await db('contacts').where({ id: contactId, organization_id: organizationId }).first();
  if (!contact) throw new NotFoundError('Contact');

  const identifiers = await db('contact_identifiers').where({ organization_id: organizationId, contact_id: contactId }).pluck('value_normalized');
  const sharedIdentifierContacts = identifiers.length
    ? await db('contact_identifiers')
        .where('organization_id', organizationId)
        .whereIn('value_normalized', identifiers)
        .whereNot('contact_id', contactId)
        .pluck('contact_id')
    : [];

  const nameMatches = await db('contacts')
    .where('organization_id', organizationId)
    .whereNull('deleted_at')
    .whereNot('id', contactId)
    .where('display_name', 'like', `${String(contact.display_name).slice(0, 6)}%`)
    .limit(10)
    .select('id', 'reference', 'display_name', 'created_at');

  const candidateIds = new Set([...sharedIdentifierContacts, ...nameMatches.map((row) => row.id)]);
  if (candidateIds.size === 0) return [];

  const candidates = await db('contacts').where('organization_id', organizationId).whereIn('id', [...candidateIds]).whereNull('deleted_at');
  return candidates.map((candidate) => ({
    ...candidate,
    reason: sharedIdentifierContacts.includes(candidate.id) ? 'shared_identifier' : 'similar_name',
    confidence: sharedIdentifierContacts.includes(candidate.id) ? 0.95 : 0.5,
  }));
}
