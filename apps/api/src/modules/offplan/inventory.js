import { getDb, withTransaction, lockRow } from '@govyzer/database';
import {
  newId,
  NotFoundError,
  ValidationError,
  ConflictError,
  unitStockMachine,
  RESERVABLE_UNIT_STATUSES,
} from '@govyzer/domain';
import { nextReference } from '../../core/references.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';
import { enqueueJob } from '../../core/jobs.js';
import { JOB_TYPES } from '../../jobs/index.js';
import { recordAudit } from '../../core/audit.js';

async function recordUnitStatus({ trx, organizationId, unit, toStatus, reason, actor, relatedType = null, relatedId = null, isOverride = false }) {
  await trx('unit_status_history').insert({
    id: newId(),
    organization_id: organizationId,
    unit_id: unit.id,
    from_status: unit.stock_status,
    to_status: toStatus,
    reason,
    changed_by_membership_id: actor?.membershipId ?? null,
    related_entity_type: relatedType,
    related_entity_id: relatedId,
    is_override: isOverride,
  });
}

/** Places an expiring soft lock on a unit. Only one active hold can exist per unit. */
export async function createHold({ organizationId, actor, payload }) {
  const db = getDb();
  return withTransaction(db, async (trx) => {
    const unit = await lockRow(trx, 'units', { id: payload.unit_id, organization_id: organizationId });
    if (!unit || unit.deleted_at) throw new NotFoundError('Unit');
    if (!RESERVABLE_UNIT_STATUSES.includes(unit.stock_status)) {
      throw new ConflictError(`Unit ${unit.unit_number} is ${unit.stock_status} and cannot be held`, { stock_status: unit.stock_status });
    }
    const activeHold = await trx('unit_holds').where({ organization_id: organizationId, unit_id: unit.id, status: 'active' }).first();
    if (activeHold) throw new ConflictError('This unit is already on hold', { hold_id: activeHold.id, expires_at: activeHold.expires_at });

    const expiresAt = new Date(Date.now() + payload.duration_minutes * 60 * 1000);
    const holdId = newId();
    await trx('unit_holds').insert({
      id: holdId,
      organization_id: organizationId,
      unit_id: unit.id,
      project_id: unit.project_id,
      lead_id: payload.lead_id ?? null,
      contact_id: payload.contact_id ?? null,
      held_by_membership_id: actor.membershipId,
      status: 'active',
      reason: payload.reason ?? null,
      expires_at: expiresAt,
    });

    unitStockMachine.assert(unit.stock_status, 'on_hold');
    await recordUnitStatus({ trx, organizationId, unit, toStatus: 'on_hold', reason: payload.reason ?? 'hold created', actor, relatedType: 'unit_hold', relatedId: holdId });
    await trx('units').where('id', unit.id).update({ stock_status: 'on_hold', hold_id: holdId, updated_at: trx.fn.now(), updated_by: actor.membershipId });

    await enqueueJob({
      organizationId,
      jobType: JOB_TYPES.HOLD_EXPIRE,
      payload: { hold_id: holdId },
      runAfter: expiresAt,
      dedupeKey: `hold-expire:${holdId}`,
      trx,
    });
    await recordAudit({ organizationId, actor, action: 'unit.held', entityType: 'unit', entityId: unit.id, after: { hold_id: holdId, expires_at: expiresAt }, trx });
    return trx('unit_holds').where('id', holdId).first();
  });
}

export async function releaseHold({ organizationId, actor, holdId, reason = 'released', isOverride = false }) {
  const db = getDb();
  return withTransaction(db, async (trx) => {
    const hold = await lockRow(trx, 'unit_holds', { id: holdId, organization_id: organizationId });
    if (!hold) throw new NotFoundError('Hold');
    if (hold.status !== 'active') return hold;

    await trx('unit_holds').where('id', hold.id).update({
      status: 'released',
      released_at: trx.fn.now(),
      released_by_membership_id: actor?.membershipId ?? null,
      release_reason: reason,
      is_override: isOverride,
      override_by_membership_id: isOverride ? actor?.membershipId ?? null : null,
    });

    const unit = await lockRow(trx, 'units', { id: hold.unit_id, organization_id: organizationId });
    if (unit && unit.stock_status === 'on_hold') {
      await recordUnitStatus({ trx, organizationId, unit, toStatus: 'available', reason, actor, relatedType: 'unit_hold', relatedId: hold.id, isOverride });
      await trx('units').where('id', unit.id).update({ stock_status: 'available', hold_id: null, updated_at: trx.fn.now() });
    }
    return trx('unit_holds').where('id', hold.id).first();
  });
}

/**
 * Creates a reservation. The unit row is locked and its status is flipped with an atomic
 * conditional update, so two agents reserving the same unit cannot both succeed.
 */
export async function createReservation({ organizationId, actor, payload, idempotencyKey = null }) {
  const db = getDb();

  if (idempotencyKey) {
    const existing = await db('reservations').where({ organization_id: organizationId, idempotency_key: idempotencyKey }).first();
    if (existing) return { reservation: existing, replayed: true };
  }

  const reservation = await withTransaction(db, async (trx) => {
    const unit = await lockRow(trx, 'units', { id: payload.unit_id, organization_id: organizationId });
    if (!unit || unit.deleted_at) throw new NotFoundError('Unit');

    if (!RESERVABLE_UNIT_STATUSES.includes(unit.stock_status)) {
      throw new ConflictError(`Unit ${unit.unit_number} is ${unit.stock_status} and cannot be reserved`, {
        unit_id: unit.id,
        stock_status: unit.stock_status,
      });
    }

    if (unit.stock_status === 'on_hold') {
      const hold = await trx('unit_holds').where({ organization_id: organizationId, unit_id: unit.id, status: 'active' }).first();
      const holdBelongsToActor = hold && (hold.held_by_membership_id === actor.membershipId || (payload.lead_id && hold.lead_id === payload.lead_id));
      if (hold && !holdBelongsToActor) {
        throw new ConflictError('This unit is held by another agent', { hold_id: hold.id, expires_at: hold.expires_at });
      }
      if (hold) {
        await trx('unit_holds').where('id', hold.id).update({ status: 'converted', released_at: trx.fn.now(), release_reason: 'converted to reservation' });
      }
    }

    const contact = await trx('contacts').where({ id: payload.contact_id, organization_id: organizationId }).whereNull('deleted_at').first();
    if (!contact) throw new NotFoundError('Contact');

    // Atomic acquisition: only succeeds while the unit is still eligible.
    const acquired = await trx('units')
      .where({ id: unit.id, organization_id: organizationId })
      .whereIn('stock_status', RESERVABLE_UNIT_STATUSES)
      .update({
        stock_status: 'reserved',
        hold_id: null,
        updated_at: trx.fn.now(),
        updated_by: actor.membershipId,
        version: trx.raw('`version` + 1'),
      });
    if (acquired === 0) {
      throw new ConflictError('This unit was reserved by someone else moments ago', { unit_id: unit.id });
    }

    const reference = await nextReference({ trx, organizationId, entity: 'reservation', prefix: actor?.referencePrefix ?? 'GVZ' });
    const id = newId();
    const expiresAt = new Date(Date.now() + payload.expires_in_hours * 60 * 60 * 1000);

    await trx('reservations').insert({
      id,
      organization_id: organizationId,
      reference,
      unit_id: unit.id,
      project_id: unit.project_id,
      lead_id: payload.lead_id ?? null,
      contact_id: payload.contact_id,
      agent_membership_id: payload.agent_membership_id ?? actor.membershipId,
      manager_membership_id: actor.managerMembershipId ?? null,
      team_id: actor.teamId ?? null,
      status: 'pending',
      payment_plan_id: payload.payment_plan_id ?? unit.payment_plan_id ?? null,
      unit_price: payload.unit_price ?? unit.current_price ?? unit.base_price ?? null,
      reservation_amount: payload.reservation_amount ?? null,
      discount_amount: payload.discount_amount ?? null,
      currency: payload.currency ?? unit.currency ?? 'AED',
      expires_at: expiresAt,
      terms: payload.terms ? JSON.stringify(payload.terms) : null,
      idempotency_key: idempotencyKey,
      created_by: actor.membershipId,
      updated_by: actor.membershipId,
    });

    await trx('units').where('id', unit.id).update({ reservation_id: id });
    await recordUnitStatus({ trx, organizationId, unit, toStatus: 'reserved', reason: `reservation ${reference}`, actor, relatedType: 'reservation', relatedId: id });
    await trx('reservation_status_history').insert({
      id: newId(),
      organization_id: organizationId,
      reservation_id: id,
      from_status: null,
      to_status: 'pending',
      reason: 'reservation created',
      changed_by_membership_id: actor.membershipId,
    });

    await enqueueJob({
      organizationId,
      jobType: JOB_TYPES.RESERVATION_EXPIRE,
      payload: { reservation_id: id },
      runAfter: expiresAt,
      dedupeKey: `reservation-expire:${id}`,
      trx,
    });

    await emitEvent(trx, {
      organizationId,
      eventType: EVENT_TYPES.RESERVATION_CREATED,
      aggregateType: 'reservation',
      aggregateId: id,
      payload: {
        reservation_id: id,
        reference,
        unit_id: unit.id,
        unit_number: unit.unit_number,
        project_id: unit.project_id,
        agent_membership_id: payload.agent_membership_id ?? actor.membershipId,
        amount: payload.unit_price ?? unit.current_price ?? null,
        currency: payload.currency ?? unit.currency ?? 'AED',
      },
    });

    if (payload.lead_id) {
      await trx('leads').where({ id: payload.lead_id, organization_id: organizationId }).update({ last_activity_at: trx.fn.now() });
    }
    return trx('reservations').where('id', id).first();
  });

  await recordAudit({
    organizationId,
    actor,
    action: 'reservation.created',
    entityType: 'reservation',
    entityId: reservation.id,
    after: { reference: reservation.reference, unit_id: reservation.unit_id },
  });
  return { reservation, replayed: false };
}

export async function extendReservation({ organizationId, actor, reservationId, additionalHours, reason }) {
  const db = getDb();
  return withTransaction(db, async (trx) => {
    const reservation = await lockRow(trx, 'reservations', { id: reservationId, organization_id: organizationId });
    if (!reservation) throw new NotFoundError('Reservation');
    if (!['pending', 'confirmed', 'extended'].includes(reservation.status)) {
      throw new ConflictError(`A ${reservation.status} reservation cannot be extended`);
    }

    const previous = reservation.expires_at ? new Date(reservation.expires_at) : new Date();
    const next = new Date(Math.max(previous.getTime(), Date.now()) + additionalHours * 60 * 60 * 1000);

    await trx('reservation_extensions').insert({
      id: newId(),
      organization_id: organizationId,
      reservation_id: reservation.id,
      previous_expires_at: previous,
      new_expires_at: next,
      reason: reason ?? null,
      requested_by_membership_id: actor.membershipId,
      approved_by_membership_id: actor.membershipId,
      status: 'approved',
    });
    await trx('reservations').where('id', reservation.id).update({
      expires_at: next,
      status: 'extended',
      extension_count: Number(reservation.extension_count ?? 0) + 1,
      updated_at: trx.fn.now(),
      updated_by: actor.membershipId,
    });
    await trx('reservation_status_history').insert({
      id: newId(),
      organization_id: organizationId,
      reservation_id: reservation.id,
      from_status: reservation.status,
      to_status: 'extended',
      reason: reason ?? 'extended',
      changed_by_membership_id: actor.membershipId,
    });
    await enqueueJob({
      organizationId,
      jobType: JOB_TYPES.RESERVATION_EXPIRE,
      payload: { reservation_id: reservation.id },
      runAfter: next,
      dedupeKey: `reservation-expire:${reservation.id}:${next.getTime()}`,
      trx,
    });
    return trx('reservations').where('id', reservation.id).first();
  });
}

export async function cancelReservation({ organizationId, actor, reservationId, reason, releaseUnit = true }) {
  const db = getDb();
  return withTransaction(db, async (trx) => {
    const reservation = await lockRow(trx, 'reservations', { id: reservationId, organization_id: organizationId });
    if (!reservation) throw new NotFoundError('Reservation');
    if (reservation.status === 'cancelled') return reservation;

    await trx('reservations').where('id', reservation.id).update({
      status: 'cancelled',
      cancelled_at: trx.fn.now(),
      cancel_reason: reason,
      updated_by: actor?.membershipId ?? null,
      updated_at: trx.fn.now(),
    });
    await trx('reservation_status_history').insert({
      id: newId(),
      organization_id: organizationId,
      reservation_id: reservation.id,
      from_status: reservation.status,
      to_status: 'cancelled',
      reason,
      changed_by_membership_id: actor?.membershipId ?? null,
    });
    await trx('cancellations').insert({
      id: newId(),
      organization_id: organizationId,
      entity_type: 'reservation',
      entity_id: reservation.id,
      reason_code: 'reservation_cancelled',
      reason,
      status: 'recorded',
      requested_by_membership_id: actor?.membershipId ?? null,
    });

    if (releaseUnit) {
      const unit = await lockRow(trx, 'units', { id: reservation.unit_id, organization_id: organizationId });
      if (unit && ['reserved', 'booked'].includes(unit.stock_status)) {
        await recordUnitStatus({ trx, organizationId, unit, toStatus: 'available', reason: `reservation cancelled: ${reason}`, actor, relatedType: 'reservation', relatedId: reservation.id });
        await trx('units').where('id', unit.id).update({ stock_status: 'available', reservation_id: null, updated_at: trx.fn.now() });
      }
    }
    return trx('reservations').where('id', reservation.id).first();
  });
}

/** Expiry job entry point. Safe to run repeatedly. */
export async function expireReservation({ db = getDb(), reservationId }) {
  return withTransaction(db, async (trx) => {
    const reservation = await lockRow(trx, 'reservations', { id: reservationId });
    if (!reservation) return { skipped: true, reason: 'missing' };
    if (!['pending', 'confirmed', 'extended'].includes(reservation.status)) return { skipped: true, reason: reservation.status };
    if (reservation.expires_at && new Date(reservation.expires_at) > new Date()) return { skipped: true, reason: 'not_yet_due' };

    await trx('reservations').where('id', reservation.id).update({ status: 'expired', updated_at: trx.fn.now() });
    await trx('reservation_status_history').insert({
      id: newId(),
      organization_id: reservation.organization_id,
      reservation_id: reservation.id,
      from_status: reservation.status,
      to_status: 'expired',
      reason: 'reservation window elapsed',
    });

    const unit = await lockRow(trx, 'units', { id: reservation.unit_id });
    if (unit && unit.stock_status === 'reserved') {
      await recordUnitStatus({ trx, organizationId: reservation.organization_id, unit, toStatus: 'available', reason: 'reservation expired', actor: null, relatedType: 'reservation', relatedId: reservation.id });
      await trx('units').where('id', unit.id).update({ stock_status: 'available', reservation_id: null, updated_at: trx.fn.now() });
    }

    await emitEvent(trx, {
      organizationId: reservation.organization_id,
      eventType: EVENT_TYPES.RESERVATION_EXPIRED,
      aggregateType: 'reservation',
      aggregateId: reservation.id,
      payload: { reservation_id: reservation.id, unit_id: reservation.unit_id },
    });
    if (reservation.agent_membership_id) {
      await trx('notifications').insert({
        id: newId(),
        organization_id: reservation.organization_id,
        membership_id: reservation.agent_membership_id,
        type: 'reservation.expired',
        title: 'Reservation expired',
        body: `Reservation ${reservation.reference} expired and the unit is available again.`,
        entity_type: 'reservation',
        entity_id: reservation.id,
        priority: 'high',
      });
    }
    return { expired: true };
  });
}

export async function expireHold({ db = getDb(), holdId }) {
  return withTransaction(db, async (trx) => {
    const hold = await lockRow(trx, 'unit_holds', { id: holdId });
    if (!hold || hold.status !== 'active') return { skipped: true };
    if (new Date(hold.expires_at) > new Date()) return { skipped: true, reason: 'not_yet_due' };

    await trx('unit_holds').where('id', hold.id).update({ status: 'expired', released_at: trx.fn.now(), release_reason: 'hold window elapsed' });
    const unit = await lockRow(trx, 'units', { id: hold.unit_id });
    if (unit && unit.stock_status === 'on_hold') {
      await recordUnitStatus({ trx, organizationId: hold.organization_id, unit, toStatus: 'available', reason: 'hold expired', actor: null, relatedType: 'unit_hold', relatedId: hold.id });
      await trx('units').where('id', unit.id).update({ stock_status: 'available', hold_id: null, updated_at: trx.fn.now() });
    }
    return { expired: true };
  });
}

/** Converts a confirmed reservation into a booking and moves the unit to booked. */
export async function createBooking({ organizationId, actor, reservationId, payload = {} }) {
  const db = getDb();
  return withTransaction(db, async (trx) => {
    const reservation = await lockRow(trx, 'reservations', { id: reservationId, organization_id: organizationId });
    if (!reservation) throw new NotFoundError('Reservation');
    if (!['pending', 'confirmed', 'extended'].includes(reservation.status)) {
      throw new ConflictError(`A ${reservation.status} reservation cannot be booked`);
    }
    const unit = await lockRow(trx, 'units', { id: reservation.unit_id, organization_id: organizationId });
    unitStockMachine.assert(unit.stock_status, 'booked');

    const reference = await nextReference({ trx, organizationId, entity: 'booking', prefix: actor?.referencePrefix ?? 'GVZ' });
    const id = newId();
    await trx('bookings').insert({
      id,
      organization_id: organizationId,
      reference,
      reservation_id: reservation.id,
      unit_id: unit.id,
      contact_id: reservation.contact_id,
      payment_plan_id: reservation.payment_plan_id,
      status: 'active',
      total_price: payload.total_price ?? reservation.unit_price,
      paid_amount: payload.paid_amount ?? reservation.reservation_amount ?? 0,
      currency: reservation.currency,
      booking_date: payload.booking_date ?? new Date(),
      created_by: actor.membershipId,
      updated_by: actor.membershipId,
    });

    await trx('units').where('id', unit.id).update({ stock_status: 'booked', updated_at: trx.fn.now(), updated_by: actor.membershipId });
    await recordUnitStatus({ trx, organizationId, unit, toStatus: 'booked', reason: `booking ${reference}`, actor, relatedType: 'booking', relatedId: id });
    await trx('reservations').where('id', reservation.id).update({ status: 'converted', converted_at: trx.fn.now(), updated_at: trx.fn.now() });
    await trx('reservation_status_history').insert({
      id: newId(),
      organization_id: organizationId,
      reservation_id: reservation.id,
      from_status: reservation.status,
      to_status: 'converted',
      reason: `converted to booking ${reference}`,
      changed_by_membership_id: actor.membershipId,
    });
    await emitEvent(trx, {
      organizationId,
      eventType: EVENT_TYPES.BOOKING_CREATED,
      aggregateType: 'booking',
      aggregateId: id,
      payload: { booking_id: id, reference, unit_id: unit.id, reservation_id: reservation.id, agent_membership_id: reservation.agent_membership_id },
    });
    return trx('bookings').where('id', id).first();
  });
}

/** Applies a payment plan to a unit price and returns the resulting installment schedule. */
export async function buildPaymentSchedule({ organizationId, unitId, paymentPlanId, price = null }) {
  const db = getDb();
  const unit = await db('units').where({ id: unitId, organization_id: organizationId }).first();
  if (!unit) throw new NotFoundError('Unit');
  const plan = await db('project_payment_plans').where({ id: paymentPlanId, organization_id: organizationId }).first();
  if (!plan) throw new NotFoundError('Payment plan');
  const installments = await db('payment_plan_installments')
    .where({ organization_id: organizationId, payment_plan_id: plan.id })
    .orderBy('position');

  const total = Number(price ?? unit.current_price ?? unit.base_price ?? 0);
  if (total <= 0) throw new ValidationError('The unit has no price, so a schedule cannot be produced');

  const rows = installments.map((installment) => {
    const amount = installment.percentage != null ? (total * Number(installment.percentage)) / 100 : Number(installment.fixed_amount ?? 0);
    let dueOn = installment.due_on ?? null;
    if (!dueOn && installment.trigger_type === 'months_after_booking' && installment.months_after_booking != null) {
      const date = new Date();
      date.setMonth(date.getMonth() + Number(installment.months_after_booking));
      dueOn = date.toISOString().slice(0, 10);
    }
    return {
      position: installment.position,
      label: installment.label,
      percentage: installment.percentage,
      amount: Math.round(amount * 100) / 100,
      trigger_type: installment.trigger_type,
      milestone: installment.milestone,
      due_on: dueOn,
    };
  });

  const dldFee = plan.dld_fee_percentage ? (total * Number(plan.dld_fee_percentage)) / 100 : 0;
  return {
    unit_id: unit.id,
    payment_plan: { id: plan.id, name: plan.name, code: plan.code, plan_type: plan.plan_type },
    currency: unit.currency,
    total_price: total,
    dld_fee: Math.round(dldFee * 100) / 100,
    admin_fee: Number(plan.admin_fee ?? 0),
    installments: rows,
    installments_total: Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100,
  };
}
