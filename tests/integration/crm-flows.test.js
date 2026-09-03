import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@govyzer/domain';
import { closeDatabase, createTestOrganization, prepareDatabase, truncateAll } from '../helpers/db.js';
import { createLead, claimFromPool, releaseToPool } from '../../apps/api/src/modules/leads/service.js';
import { processSlaEvent } from '../../apps/api/src/modules/leads/sla.js';
import { createHold, createReservation, expireReservation } from '../../apps/api/src/modules/offplan/inventory.js';
import { importStock } from '../../apps/api/src/modules/offplan/stock-import.js';
import { createDeal, changeStage as changeDealStage } from '../../apps/api/src/modules/deals/service.js';
import { processOutboxBatch } from '../../apps/api/src/jobs/outbox-processor.js';
import { runJobBatch, enqueueJob } from '../../apps/api/src/core/jobs.js';
import { buildActor } from '../helpers/db.js';

describe('CRM flows', () => {
  let org;
  let db;

  beforeAll(async () => {
    db = await prepareDatabase();
    await truncateAll();
    org = await createTestOrganization({ slug: 'flows' });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('deduplicates a repeat enquiry onto the existing contact instead of dropping it', async () => {
    const first = await createLead({
      organizationId: org.organizationId,
      actor: org.actor,
      payload: { module: 'ready', purpose: 'buy', contact: { first_name: 'Omar', identifiers: [{ identifier_type: 'phone', value: '0501234567' }] } },
    });
    const second = await createLead({
      organizationId: org.organizationId,
      actor: org.actor,
      payload: { module: 'offplan', purpose: 'invest', contact: { first_name: 'Omar', identifiers: [{ identifier_type: 'phone', value: '+971501234567' }] } },
    });

    expect(second.contact.id).toBe(first.contact.id);
    expect(second.lead.id).not.toBe(first.lead.id);
    const leadCount = await db('leads').where({ organization_id: org.organizationId, contact_id: first.contact.id }).count({ total: 'id' }).first();
    expect(Number(leadCount.total)).toBe(2);
  });

  it('schedules SLA timers and escalates to the pool when nothing happens', async () => {
    const { lead } = await createLead({
      organizationId: org.organizationId,
      actor: org.actor,
      payload: { module: 'ready', purpose: 'buy', contact: { first_name: 'SLA', identifiers: [{ identifier_type: 'phone', value: '0502223333' }] } },
    });

    const events = await db('lead_sla_events').where({ organization_id: org.organizationId, lead_id: lead.id }).orderBy('due_at');
    expect(events.map((event) => event.event_type)).toEqual(['acknowledge', 'manager_alert', 'pool_release']);

    const poolEvent = events.find((event) => event.event_type === 'pool_release');
    const outcome = await processSlaEvent({ db, organizationId: org.organizationId, slaEventId: poolEvent.id });
    expect(outcome.action).toBe('release_to_pool');

    const pooled = await db('leads').where('id', lead.id).first();
    expect(Boolean(pooled.is_in_pool)).toBe(true);
    expect(pooled.assigned_membership_id).toBeNull();
  });

  it('lets exactly one agent claim a pooled lead', async () => {
    const { lead } = await createLead({
      organizationId: org.organizationId,
      actor: org.actor,
      payload: { module: 'ready', purpose: 'buy', contact: { first_name: 'Pool', identifiers: [{ identifier_type: 'phone', value: '0504445555' }] } },
    });
    await releaseToPool({ organizationId: org.organizationId, actor: org.actor, id: lead.id, reason: 'test' });

    const agentActor = buildActor({ organization: org.organization, membershipId: org.agent.membershipId, userId: org.agent.userId });
    const results = await Promise.allSettled([
      claimFromPool({ organizationId: org.organizationId, actor: org.actor, id: lead.id }),
      claimFromPool({ organizationId: org.organizationId, actor: agentActor, id: lead.id }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });

  it('imports unit stock idempotently and reports error rows without failing the batch', async () => {
    const developerId = newId();
    await db('developers').insert({ id: developerId, organization_id: org.organizationId, name: 'Dev', slug: 'dev', is_active: true });
    const projectId = newId();
    await db('projects').insert({
      id: projectId,
      organization_id: org.organizationId,
      developer_id: developerId,
      name: 'Project',
      reference: 'P-1',
      slug: 'project',
      status: 'selling',
    });

    const payload = {
      project_id: projectId,
      mode: 'commit',
      idempotency_key: 'batch-1',
      rows: [
        { unit_number: 'A-101', current_price: 1000000, stock_status: 'available', bedrooms: 1 },
        { unit_number: 'A-102', current_price: 1200000, stock_status: 'available', bedrooms: 2 },
        { unit_number: 'A-103', current_price: -1 },
      ],
    };

    const first = await importStock({ organizationId: org.organizationId, actor: org.actor, payload });
    expect(first.batch.created_units).toBe(2);
    expect(first.batch.error_rows).toBe(1);

    const replay = await importStock({ organizationId: org.organizationId, actor: org.actor, payload });
    expect(replay.replayed).toBe(true);
    const units = await db('units').where({ organization_id: org.organizationId, project_id: projectId }).count({ total: 'id' }).first();
    expect(Number(units.total)).toBe(2);
  });

  it('prevents double booking under concurrent reservation attempts', async () => {
    const unit = await db('units').where({ organization_id: org.organizationId, stock_status: 'available' }).first();
    const contact = await db('contacts').where('organization_id', org.organizationId).first();
    const agentActor = buildActor({ organization: org.organization, membershipId: org.agent.membershipId, userId: org.agent.userId });

    const results = await Promise.allSettled([
      createReservation({ organizationId: org.organizationId, actor: org.actor, payload: { unit_id: unit.id, contact_id: contact.id, expires_in_hours: 24 } }),
      createReservation({ organizationId: org.organizationId, actor: agentActor, payload: { unit_id: unit.id, contact_id: contact.id, expires_in_hours: 24 } }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.status).toBe(409);

    const updated = await db('units').where('id', unit.id).first();
    expect(updated.stock_status).toBe('reserved');
  });

  it('releases the unit when a reservation expires', async () => {
    const unit = await db('units').where({ organization_id: org.organizationId, stock_status: 'available' }).first();
    const contact = await db('contacts').where('organization_id', org.organizationId).first();
    const { reservation } = await createReservation({
      organizationId: org.organizationId,
      actor: org.actor,
      payload: { unit_id: unit.id, contact_id: contact.id, expires_in_hours: 1 },
    });

    await db('reservations').where('id', reservation.id).update({ expires_at: new Date(Date.now() - 60_000) });
    const result = await expireReservation({ db, reservationId: reservation.id });
    expect(result.expired).toBe(true);
    expect((await db('units').where('id', unit.id).first()).stock_status).toBe('available');
  });

  it('blocks a hold on a unit that is already held', async () => {
    const unit = await db('units').where({ organization_id: org.organizationId, stock_status: 'available' }).first();
    await createHold({ organizationId: org.organizationId, actor: org.actor, payload: { unit_id: unit.id, duration_minutes: 30 } });
    await expect(
      createHold({ organizationId: org.organizationId, actor: org.actor, payload: { unit_id: unit.id, duration_minutes: 30 } })
    ).rejects.toThrow(/cannot be held|already on hold/i);
  });

  it('snapshots the commission when a deal is won and drives Sales Screen events', async () => {
    const contact = await db('contacts').where('organization_id', org.organizationId).first();
    const deal = await createDeal({
      organizationId: org.organizationId,
      actor: org.actor,
      payload: { deal_type: 'ready_sale', module: 'ready', contact_id: contact.id, property_value: 2000000, commission_percentage: 2, parties: [] },
    });

    await changeDealStage({ organizationId: org.organizationId, actor: org.actor, id: deal.id, stage: 'documentation' });
    await changeDealStage({ organizationId: org.organizationId, actor: org.actor, id: deal.id, stage: 'signed' });
    const won = await changeDealStage({ organizationId: org.organizationId, actor: org.actor, id: deal.id, stage: 'won' });

    expect(won.commission.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(40000);

    const snapshot = await db('commission_snapshots').where({ organization_id: org.organizationId, deal_id: deal.id }).first();
    expect(Number(snapshot.gross_commission)).toBe(40000);

    // Changing the plan afterwards must not rewrite the snapshot.
    await db('commission_rules')
      .where('organization_id', org.organizationId)
      .update({ percentage: 90 });
    const stored = await db('commission_snapshots').where('id', snapshot.id).first();
    expect(Number(stored.gross_commission)).toBe(40000);

    await processOutboxBatch({ limit: 100 });
    const salesEvent = await db('sales_events').where({ organization_id: org.organizationId, event_type: 'deal_won' }).first();
    expect(salesEvent).toBeTruthy();
    expect(JSON.parse(salesEvent.display_payload)).not.toHaveProperty('contact_name');

    const points = await db('points_ledger').where({ organization_id: org.organizationId, event_type: 'deal_won' });
    expect(points.length).toBeGreaterThan(0);
  });

  it('reverses points when a won deal is cancelled', async () => {
    const deal = await db('deals').where({ organization_id: org.organizationId, status: 'won' }).first();
    await changeDealStage({ organizationId: org.organizationId, actor: org.actor, id: deal.id, stage: 'cancelled', reason: 'client withdrew' });
    await processOutboxBatch({ limit: 100 });

    const entries = await db('points_ledger').where({ organization_id: org.organizationId, source_entity_id: deal.id });
    const total = entries.reduce((sum, entry) => sum + Number(entry.points), 0);
    expect(total).toBe(0);

    const reversal = await db('commission_snapshots').where({ organization_id: org.organizationId, deal_id: deal.id, status: 'reversal' }).first();
    expect(reversal).toBeTruthy();
  });

  it('claims each queued job exactly once', async () => {
    await enqueueJob({ organizationId: org.organizationId, jobType: 'data.retention', payload: {}, dedupeKey: `retention-${Date.now()}` });
    const [first, second] = await Promise.all([runJobBatch({ limit: 10, budgetMs: 5000 }), runJobBatch({ limit: 10, budgetMs: 5000 })]);
    expect(first.claimed + second.claimed).toBeGreaterThan(0);
    const dead = await db('jobs').where('status', 'dead');
    expect(dead).toHaveLength(0);
  });

  it('enqueues a job only once for the same dedupe key', async () => {
    const key = `dedupe-${Date.now()}`;
    const a = await enqueueJob({ organizationId: org.organizationId, jobType: 'data.retention', payload: {}, dedupeKey: key });
    const b = await enqueueJob({ organizationId: org.organizationId, jobType: 'data.retention', payload: {}, dedupeKey: key });
    expect(a).toBe(b);
  });
});
