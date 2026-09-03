import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError, ConflictError, ValidationError, dealStateMachine } from '@govyzer/domain';
import { nextReference } from '../../core/references.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';
import { recordAudit } from '../../core/audit.js';
import { finalizeCommission, reverseCommission, previewCommission } from './commission.js';

export async function createDeal({ organizationId, actor, payload, request = {} }) {
  const db = getDb();

  const deal = await withTransaction(db, async (trx) => {
    const reference = await nextReference({ trx, organizationId, entity: 'deal', prefix: actor?.referencePrefix ?? 'GVZ' });
    const id = newId();
    const { parties, ...rest } = payload;

    if (rest.reservation_id) {
      const reservation = await trx('reservations').where({ id: rest.reservation_id, organization_id: organizationId }).first();
      if (!reservation) throw new NotFoundError('Reservation');
      rest.unit_id = rest.unit_id ?? reservation.unit_id;
      rest.project_id = rest.project_id ?? reservation.project_id;
      rest.contact_id = rest.contact_id ?? reservation.contact_id;
      rest.agent_membership_id = rest.agent_membership_id ?? reservation.agent_membership_id;
      rest.property_value = rest.property_value ?? reservation.unit_price;
    }
    if (rest.lead_id && !rest.contact_id) {
      const lead = await trx('leads').where({ id: rest.lead_id, organization_id: organizationId }).first();
      if (lead) rest.contact_id = lead.contact_id;
    }

    const grossCommission =
      rest.gross_commission ??
      (rest.property_value && rest.commission_percentage
        ? Math.round(Number(rest.property_value) * Number(rest.commission_percentage)) / 100
        : null);

    await trx('deals').insert({
      id,
      organization_id: organizationId,
      reference,
      ...rest,
      gross_commission: grossCommission,
      agent_membership_id: rest.agent_membership_id ?? actor.membershipId,
      manager_membership_id: rest.manager_membership_id ?? actor.managerMembershipId ?? null,
      team_id: actor.teamId ?? null,
      branch_id: actor.branchId ?? null,
      stage: 'draft',
      status: 'open',
      created_by: actor.membershipId,
      updated_by: actor.membershipId,
    });

    const partyRows = [...(parties ?? [])];
    if (rest.contact_id && !partyRows.some((party) => party.contact_id === rest.contact_id)) {
      partyRows.push({
        party_role: payload.deal_type === 'ready_rental' ? 'tenant' : 'buyer',
        party_type: 'contact',
        contact_id: rest.contact_id,
      });
    }
    if (rest.agent_membership_id ?? actor.membershipId) {
      partyRows.push({ party_role: 'internal_agent', party_type: 'membership', membership_id: rest.agent_membership_id ?? actor.membershipId });
    }
    if (partyRows.length > 0) {
      await trx('deal_parties').insert(
        partyRows.map((party) => ({
          id: newId(),
          organization_id: organizationId,
          deal_id: id,
          party_role: party.party_role,
          party_type: party.party_type ?? 'contact',
          contact_id: party.contact_id ?? null,
          membership_id: party.membership_id ?? null,
          developer_id: party.developer_id ?? null,
          company_name: party.company_name ?? null,
          share_percentage: party.share_percentage ?? null,
        }))
      );
    }

    await trx('deal_stage_history').insert({
      id: newId(),
      organization_id: organizationId,
      deal_id: id,
      from_stage: null,
      to_stage: 'draft',
      reason: 'deal created',
      changed_by_membership_id: actor.membershipId,
    });

    if (rest.lead_id) await trx('leads').where({ id: rest.lead_id, organization_id: organizationId }).update({ deal_id: id, last_activity_at: trx.fn.now() });

    await emitEvent(trx, {
      organizationId,
      eventType: EVENT_TYPES.DEAL_CREATED,
      aggregateType: 'deal',
      aggregateId: id,
      payload: { deal_id: id, reference, deal_type: rest.deal_type, property_value: rest.property_value ?? null },
    });

    return trx('deals').where('id', id).first();
  });

  await recordAudit({ organizationId, actor, action: 'deal.created', entityType: 'deal', entityId: deal.id, after: { reference: deal.reference }, requestId: request.requestId });
  return deal;
}

export async function getDeal({ organizationId, id }) {
  const db = getDb();
  const deal = await db('deals').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!deal) throw new NotFoundError('Deal');

  const [parties, stageHistory, approvals, documents, invoices, payments, snapshot] = await Promise.all([
    db('deal_parties').where({ organization_id: organizationId, deal_id: id }),
    db('deal_stage_history').where({ organization_id: organizationId, deal_id: id }).orderBy('created_at', 'desc'),
    db('deal_approvals').where({ organization_id: organizationId, deal_id: id }).orderBy('created_at', 'desc'),
    db('generated_documents').where({ organization_id: organizationId, entity_type: 'deal', entity_id: id }).whereNull('deleted_at'),
    db('invoices').where({ organization_id: organizationId, deal_id: id }).whereNull('deleted_at'),
    db('payments').where({ organization_id: organizationId, deal_id: id }).whereNull('deleted_at'),
    deal.commission_snapshot_id ? db('commission_snapshots').where('id', deal.commission_snapshot_id).first() : null,
  ]);

  const commissionLines = snapshot
    ? await db('commission_lines').where({ organization_id: organizationId, snapshot_id: snapshot.id })
    : [];

  return {
    ...deal,
    parties,
    stage_history: stageHistory,
    approvals,
    documents,
    invoices,
    payments,
    commission_snapshot: snapshot
      ? {
          ...snapshot,
          rules_snapshot: typeof snapshot.rules_snapshot === 'string' ? JSON.parse(snapshot.rules_snapshot) : snapshot.rules_snapshot,
          inputs_snapshot: typeof snapshot.inputs_snapshot === 'string' ? JSON.parse(snapshot.inputs_snapshot) : snapshot.inputs_snapshot,
          lines: commissionLines,
        }
      : null,
  };
}

export async function updateDeal({ organizationId, actor, id, payload }) {
  const db = getDb();
  const before = await db('deals').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!before) throw new NotFoundError('Deal');
  if (before.status === 'won' && before.commission_snapshot_id) {
    throw new ConflictError('A won deal with a commission snapshot must be amended through a cancellation or approval');
  }

  const { parties, version, ...rest } = payload;
  const updates = { ...rest, updated_by: actor.membershipId, updated_at: db.fn.now() };
  if (rest.property_value != null && rest.commission_percentage != null && rest.gross_commission == null) {
    updates.gross_commission = Math.round(Number(rest.property_value) * Number(rest.commission_percentage)) / 100;
  }
  Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

  await withTransaction(db, async (trx) => {
    let query = trx('deals').where({ id, organization_id: organizationId });
    if (version != null) query = query.where('version', version);
    const updated = await query.update({ ...updates, version: trx.raw('`version` + 1') });
    if (updated === 0) throw new ConflictError('This deal was changed by someone else. Reload and try again.');

    if (parties) {
      await trx('deal_parties').where({ organization_id: organizationId, deal_id: id }).delete();
      if (parties.length > 0) {
        await trx('deal_parties').insert(
          parties.map((party) => ({
            id: newId(),
            organization_id: organizationId,
            deal_id: id,
            party_role: party.party_role,
            party_type: party.party_type ?? 'contact',
            contact_id: party.contact_id ?? null,
            membership_id: party.membership_id ?? null,
            developer_id: party.developer_id ?? null,
            company_name: party.company_name ?? null,
            share_percentage: party.share_percentage ?? null,
          }))
        );
      }
    }
  });

  const after = await db('deals').where('id', id).first();
  await recordAudit({ organizationId, actor, action: 'deal.updated', entityType: 'deal', entityId: id, before, after });
  await emitEvent(db, {
    organizationId,
    eventType: EVENT_TYPES.DEAL_UPDATED,
    aggregateType: 'deal',
    aggregateId: id,
    payload: { deal_id: id, changed_fields: Object.keys(updates) },
  });
  return after;
}

/**
 * Moves the deal through its lifecycle. Winning a deal snapshots the commission split and
 * emits the event the Sales Screen and points ledger consume.
 */
export async function changeStage({ organizationId, actor, id, stage, reason }) {
  const db = getDb();
  const deal = await db('deals').where({ id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!deal) throw new NotFoundError('Deal');
  dealStateMachine.assert(deal.stage, stage);

  if (stage === 'won' && !deal.gross_commission) {
    throw new ValidationError('A gross commission amount is required before a deal can be won', [
      { path: 'gross_commission', message: 'Required to calculate the commission split' },
    ]);
  }

  const result = await withTransaction(db, async (trx) => {
    const updates = {
      stage,
      updated_by: actor.membershipId,
      updated_at: trx.fn.now(),
    };
    if (stage === 'won') {
      updates.status = 'won';
      updates.won_at = trx.fn.now();
    }
    if (stage === 'lost') {
      updates.status = 'lost';
      updates.lost_at = trx.fn.now();
      updates.loss_reason = reason ?? null;
    }
    if (stage === 'cancelled') {
      updates.status = 'cancelled';
      updates.cancelled_at = trx.fn.now();
      updates.cancel_reason = reason ?? null;
    }
    await trx('deals').where('id', id).update(updates);
    await trx('deal_stage_history').insert({
      id: newId(),
      organization_id: organizationId,
      deal_id: id,
      from_stage: deal.stage,
      to_stage: stage,
      reason: reason ?? null,
      changed_by_membership_id: actor.membershipId,
    });

    let commission = null;
    if (stage === 'won') {
      const current = await trx('deals').where('id', id).first();
      commission = await finalizeCommission({ trx, organizationId, actor, deal: current });

      const agent = current.agent_membership_id
        ? await trx('organization_memberships as m')
            .join('users as u', 'u.id', 'm.user_id')
            .where('m.id', current.agent_membership_id)
            .first('u.first_name', 'u.last_name', 'm.team_id', 'm.branch_id')
        : null;

      await emitEvent(trx, {
        organizationId,
        eventType: EVENT_TYPES.DEAL_WON,
        aggregateType: 'deal',
        aggregateId: id,
        payload: {
          deal_id: id,
          reference: current.reference,
          deal_type: current.deal_type,
          module: current.module,
          property_value: Number(current.property_value ?? 0),
          gross_commission: Number(current.gross_commission ?? 0),
          currency: current.currency,
          agent_membership_id: current.agent_membership_id,
          agent_name: agent ? `${agent.first_name} ${agent.last_name}`.trim() : null,
          team_id: agent?.team_id ?? current.team_id,
          branch_id: agent?.branch_id ?? current.branch_id,
          project_id: current.project_id,
          unit_id: current.unit_id,
          listing_id: current.listing_id,
          is_sales_screen_eligible: Boolean(current.is_sales_screen_eligible),
          won_at: new Date().toISOString(),
        },
      });

      if (current.unit_id) {
        const unit = await trx('units').where({ id: current.unit_id, organization_id: organizationId }).first();
        if (unit && ['reserved', 'booked'].includes(unit.stock_status)) {
          await trx('units').where('id', unit.id).update({ stock_status: 'sold', deal_id: id, updated_at: trx.fn.now() });
          await trx('unit_status_history').insert({
            id: newId(),
            organization_id: organizationId,
            unit_id: unit.id,
            from_status: unit.stock_status,
            to_status: 'sold',
            reason: `deal ${current.reference} won`,
            changed_by_membership_id: actor.membershipId,
            related_entity_type: 'deal',
            related_entity_id: id,
          });
        }
      }
      if (current.lead_id) {
        await trx('leads').where({ id: current.lead_id, organization_id: organizationId }).update({
          stage_code: 'won',
          status: 'won',
          won_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        });
      }
    }

    if (stage === 'cancelled' || stage === 'lost') {
      if (deal.commission_snapshot_id) {
        await reverseCommission({ trx, organizationId, actor, dealId: id, reason: reason ?? stage });
      }
      await emitEvent(trx, {
        organizationId,
        eventType: stage === 'cancelled' ? EVENT_TYPES.DEAL_CANCELLED : EVENT_TYPES.DEAL_LOST,
        aggregateType: 'deal',
        aggregateId: id,
        payload: { deal_id: id, reason: reason ?? null, agent_membership_id: deal.agent_membership_id },
      });
      if (stage === 'cancelled') {
        await trx('cancellations').insert({
          id: newId(),
          organization_id: organizationId,
          entity_type: 'deal',
          entity_id: id,
          reason_code: 'deal_cancelled',
          reason: reason ?? null,
          status: 'recorded',
          requested_by_membership_id: actor.membershipId,
          reverses_commission: true,
          reverses_points: true,
        });
      }
    }

    return { deal: await trx('deals').where('id', id).first(), commission };
  });

  await recordAudit({ organizationId, actor, action: `deal.${stage}`, entityType: 'deal', entityId: id, before: { stage: deal.stage }, after: { stage, reason } });
  return result;
}

export { previewCommission };
