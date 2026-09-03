import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@govyzer/database';
import { closeDatabase, createTestOrganization, prepareDatabase, truncateAll } from '../helpers/db.js';
import { anonymous, signIn } from '../helpers/api.js';

describe('API behaviour', () => {
  let org;
  let owner;
  let db;

  beforeAll(async () => {
    db = await prepareDatabase();
    await truncateAll();
    org = await createTestOrganization({ slug: 'api-flows' });
    owner = await signIn({ email: org.owner.email, password: org.password });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('replays an idempotent create instead of duplicating it', async () => {
    const body = { module: 'ready', purpose: 'buy', contact: { first_name: 'Idem', identifiers: [{ identifier_type: 'phone', value: '0508881111' }] } };
    const first = await owner.post('/v1/leads').set('idempotency-key', 'lead-key-1').send(body);
    const second = await owner.post('/v1/leads').set('idempotency-key', 'lead-key-1').send(body);

    expect(first.status).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body.data.lead.id).toBe(first.body.data.lead.id);

    const conflicting = await owner.post('/v1/leads').set('idempotency-key', 'lead-key-1').send({ ...body, purpose: 'rent' });
    expect(conflicting.status).toBe(409);
  });

  it('paginates with consistent metadata', async () => {
    for (let index = 0; index < 5; index += 1) {
      await owner.post('/v1/leads').send({ module: 'ready', purpose: 'buy', contact: { first_name: `Page${index}`, identifiers: [{ identifier_type: 'phone', value: `05077700${index}${index}` }] } });
    }
    const page = await owner.get('/v1/leads?per_page=2&page=2');
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta.page).toBe(2);
    expect(page.body.meta.total).toBeGreaterThanOrEqual(6);
  });

  it('validates query parameters', async () => {
    const response = await owner.get('/v1/leads?per_page=9999');
    expect(response.status).toBe(422);
  });

  it('returns a consistent error envelope with a request id', async () => {
    const response = await owner.get('/v1/leads/not-a-valid-id');
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.request_id).toBeTruthy();
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('returns actionable portal validation errors before publishing', async () => {
    const listing = await owner.post('/v1/listings').send({
      offering_type: 'sale',
      property_type: 'apartment',
      title: 'Needs work before publishing',
      description: 'Short',
      built_up_area: 950,
    });
    const listingId = listing.body.data.listing.id;

    const account = await owner.post('/v1/portals/accounts').send({
      provider_code: 'property_finder',
      name: 'PF main',
      credentials: { feed_enabled: true },
      is_enabled: true,
    });
    expect(account.status).toBe(201);

    const validation = await owner.post(`/v1/listings/${listingId}/validate`).send({ portal_account_ids: [account.body.data.account.id] });
    expect(validation.status).toBe(200);
    const errors = validation.body.data.results[0].errors.map((error) => error.code);
    expect(errors).toContain('description_too_short');
    expect(errors).toContain('price_required');
    expect(errors).toContain('permit_required');
  });

  it('blocks publishing a listing that is not approved', async () => {
    const listing = await owner.post('/v1/listings').send({
      offering_type: 'sale',
      property_type: 'apartment',
      title: 'Draft listing that cannot publish',
      description: 'This listing is still a draft so publishing it to a portal must be refused by the API.',
      price: 1200000,
      built_up_area: 950,
    });
    const account = await db('portal_accounts').where('organization_id', org.organizationId).first();
    const response = await owner.post(`/v1/listings/${listing.body.data.listing.id}/publish`).send({ portal_account_ids: [account.id] });
    expect(response.status).toBe(409);
  });

  it('stores an inbound portal webhook and turns it into a lead', async () => {
    const account = await db('portal_accounts').where('organization_id', org.organizationId).first();
    const response = await anonymous()
      .post(`/v1/webhooks/portal/property_finder/${account.feed_token}`)
      .send({ lead_id: 'pf-123', contact: { name: 'Portal Lead', phone: '0509990000', email: 'portal.lead@example.ae' }, message: 'Interested in the marina apartment' });

    expect(response.status).toBe(200);
    expect(response.body.data.received).toBe(true);

    const duplicate = await anonymous()
      .post(`/v1/webhooks/portal/property_finder/${account.feed_token}`)
      .send({ lead_id: 'pf-123', contact: { name: 'Portal Lead', phone: '0509990000' } });
    expect(duplicate.body.data.duplicate).toBe(true);

    const { runJobBatch } = await import('../../apps/api/src/core/jobs.js');
    await runJobBatch({ limit: 20, budgetMs: 10_000 });

    const lead = await db('leads').where({ organization_id: org.organizationId, portal_code: 'property_finder' }).first();
    expect(lead).toBeTruthy();
    const receipt = await db('external_lead_receipts').where({ organization_id: org.organizationId, provider: 'property_finder' }).first();
    expect(receipt.status).toBe('processed');
  });

  it('serves a portal feed from the tenant feed token', async () => {
    const account = await db('portal_accounts').where('organization_id', org.organizationId).first();
    const response = await anonymous().get(`/v1/public/feeds/property_finder/${account.feed_token}.xml`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/xml/);
    expect(response.text).toContain('<properties');
  });

  it('rejects a feed request with an unknown token', async () => {
    const response = await anonymous().get('/v1/public/feeds/property_finder/not-a-real-token.xml');
    expect(response.status).toBe(404);
  });

  it('runs dashboards and reports from real queries', async () => {
    for (const path of ['/v1/reports/dashboards/executive', '/v1/reports/dashboards/ready', '/v1/reports/dashboards/offplan', '/v1/reports/revenue', '/v1/reports/lead_source_conversion']) {
      const response = await owner.get(path);
      expect(response.status, path).toBe(200);
    }
  });

  it('creates, publishes and runs a workflow', async () => {
    const created = await owner.post('/v1/workflows').send({
      name: 'Notify on high value lead',
      code: 'high_value',
      trigger_type: 'record_created',
      entity_type: 'lead',
      trigger_config: {},
      conditions: [{ field: 'lead.estimated_value', operator: 'gte', value: 1000000 }],
      actions: [{ position: 1, action_type: 'create_task', config: { title: 'Call the client', due_in_minutes: 60 } }],
    });
    expect(created.status).toBe(201);

    const versionId = created.body.data.current_version_id;
    const published = await owner.post(`/v1/workflows/versions/${versionId}/publish`).send({});
    expect(published.status).toBe(200);

    await owner.post('/v1/leads').send({ module: 'ready', purpose: 'buy', estimated_value: 2500000, contact: { first_name: 'Workflow', identifiers: [{ identifier_type: 'phone', value: '0501230000' }] } });

    const { processOutboxBatch } = await import('../../apps/api/src/jobs/outbox-processor.js');
    const { runJobBatch } = await import('../../apps/api/src/core/jobs.js');
    await processOutboxBatch({ limit: 100 });
    await runJobBatch({ limit: 50, budgetMs: 10_000 });

    const runs = await owner.get('/v1/workflows/runs');
    expect(runs.body.data.length).toBeGreaterThan(0);
    const task = await db('tasks').where({ organization_id: org.organizationId, title: 'Call the client' }).first();
    expect(task).toBeTruthy();
  });

  it('keeps AI features usable when AI is disabled', async () => {
    const status = await owner.get('/v1/ai/status');
    expect(status.body.data.enabled).toBe(false);

    const lead = await db('leads').where('organization_id', org.organizationId).first();
    const scoring = await owner.post('/v1/ai/run').send({ feature: 'lead_scoring', entity_type: 'lead', entity_id: lead.id, input: {} });
    expect(scoring.status).toBe(200);
    expect(scoring.body.data.ai_used).toBe(false);
    expect(scoring.body.data.result.score).toBeGreaterThan(0);

    const refreshed = await db('leads').where('id', lead.id).first();
    expect(refreshed.score).toBeGreaterThan(0);
  });

  it('exposes the Zapier contract', async () => {
    const response = await owner.get('/v1/public/zapier/triggers');
    expect(response.status).toBe(200);
    expect(response.body.data.actions[0].path).toBe('/v1/public/leads');
    expect(response.body.data.triggers.map((trigger) => trigger.key)).toContain('deal_won');
  });

  it('generates a PDF document from an approved template', async () => {
    const templates = await owner.get('/v1/documents/templates');
    const template = templates.body.data.find((entry) => entry.code === 'invoice');
    await owner.post(`/v1/documents/templates/versions/${template.current_version.id}/approve`).send({});

    const deal = await owner.post('/v1/deals').send({ deal_type: 'ready_sale', module: 'ready', property_value: 1000000, commission_percentage: 2, parties: [] });
    const generated = await owner.post('/v1/documents/generate').send({ template_id: template.id, entity_type: 'deal', entity_id: deal.body.data.id });

    expect(generated.status).toBe(201);
    expect(generated.body.data.size_bytes).toBeGreaterThan(500);
    expect(generated.body.data.template_version_number).toBe(1);
  });

  it('refuses to generate from a template that still needs approval', async () => {
    const templates = await owner.get('/v1/documents/templates');
    const template = templates.body.data.find((entry) => entry.code === 'form_f');
    const deal = await db('deals').where('organization_id', org.organizationId).first();
    const response = await owner.post('/v1/documents/generate').send({ template_id: template.id, entity_type: 'deal', entity_id: deal.id });
    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/approval/i);
  });
});
