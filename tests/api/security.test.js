import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@govyzer/database';
import { newId } from '@govyzer/domain';
import { closeDatabase, createTestOrganization, prepareDatabase, truncateAll } from '../helpers/db.js';
import { anonymous, signIn } from '../helpers/api.js';

/**
 * Security regression suite: every one of these attempts to reach another tenant's data
 * through a different door — direct id, search, export, counts, nested routes and the
 * display feed.
 */
describe('cross-tenant security', () => {
  let orgA;
  let orgB;
  let ownerA;
  let ownerB;
  let leadA;
  let listingA;
  let db;

  beforeAll(async () => {
    db = await prepareDatabase();
    await truncateAll();
    orgA = await createTestOrganization({ slug: 'sec-a' });
    orgB = await createTestOrganization({ slug: 'sec-b' });
    ownerA = await signIn({ email: orgA.owner.email, password: orgA.password });
    ownerB = await signIn({ email: orgB.owner.email, password: orgB.password });

    const lead = await ownerA
      .post('/v1/leads')
      .send({ module: 'ready', purpose: 'buy', contact: { first_name: 'Private', last_name: 'Client', identifiers: [{ identifier_type: 'phone', value: '0507770001' }] } });
    leadA = lead.body.data.lead;

    const listing = await ownerA.post('/v1/listings').send({
      offering_type: 'sale',
      property_type: 'apartment',
      title: 'Tenant A confidential listing',
      description: 'A private listing that belongs only to tenant A and must never leak to another organization.',
      price: 1500000,
      built_up_area: 900,
    });
    listingA = listing.body.data.listing;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('does not expose another tenant lead by id', async () => {
    const response = await ownerB.get(`/v1/leads/${leadA.id}`);
    expect(response.status).toBe(404);
  });

  it('does not expose another tenant listing by id', async () => {
    const response = await ownerB.get(`/v1/listings/${listingA.id}`);
    expect(response.status).toBe(404);
  });

  it('does not return another tenant record through search', async () => {
    const response = await ownerB.get('/v1/listings?q=confidential');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('does not leak another tenant record through counts', async () => {
    const response = await ownerB.get('/v1/leads?per_page=1');
    expect(response.body.meta.total).toBe(0);
  });

  it('does not return another tenant contact through the contacts list', async () => {
    const response = await ownerB.get('/v1/contacts?q=Private');
    expect(response.body.data).toHaveLength(0);
  });

  it('refuses to act on another tenant record through a nested route', async () => {
    const stage = await ownerB.post(`/v1/leads/${leadA.id}/stage`).send({ stage_code: 'qualified' });
    expect(stage.status).toBe(404);

    const publish = await ownerB.post(`/v1/listings/${listingA.id}/publish`).send({ portal_account_ids: [newId()] });
    expect([403, 404, 422]).toContain(publish.status);
  });

  it('does not include another tenant row in an export', async () => {
    const response = await ownerB.post('/v1/reports/exports').send({ entity_type: 'leads' });
    expect(response.status).toBe(201);
    const { runExport } = await import('../../apps/api/src/modules/reports/service.js');
    const result = await runExport({ db, organizationId: orgB.organizationId, exportId: response.body.data.id });
    expect(result.rows).toBe(0);
  });

  it('does not let a display session read another tenant feed or any CRM route', async () => {
    const display = await ownerA.post('/v1/sales-screen/displays').send({ name: 'Tenant A display' });
    const pairing = await ownerA.post(`/v1/sales-screen/displays/${display.body.data.id}/pairing-code`).send({});
    const claim = await anonymous().post('/v1/display/pair').send({ code: pairing.body.data.code });
    const token = claim.body.data.token;

    const feed = await anonymous().get('/v1/display/feed').set('x-display-token', token);
    expect(feed.status).toBe(200);
    expect(feed.body.data.display.id).toBe(display.body.data.id);

    // The same token must not open any ordinary CRM route.
    for (const path of ['/v1/leads', '/v1/contacts', '/v1/deals', '/v1/organization']) {
      const response = await anonymous().get(path).set('authorization', `Bearer ${token}`);
      expect(response.status).toBe(401);
    }

    // A tenant B admin cannot revoke or read a tenant A display.
    const revoke = await ownerB.post(`/v1/sales-screen/displays/${display.body.data.id}/revoke`).send({});
    expect(revoke.status).toBe(404);
  });

  it('rejects a reused pairing code and a revoked display session', async () => {
    const display = await ownerA.post('/v1/sales-screen/displays').send({ name: 'Reuse display' });
    const pairing = await ownerA.post(`/v1/sales-screen/displays/${display.body.data.id}/pairing-code`).send({});
    const first = await anonymous().post('/v1/display/pair').send({ code: pairing.body.data.code });
    expect(first.status).toBe(201);

    const second = await anonymous().post('/v1/display/pair').send({ code: pairing.body.data.code });
    expect(second.status).toBe(409);

    await ownerA.post(`/v1/sales-screen/displays/${display.body.data.id}/revoke`).send({ reason: 'test' });
    const afterRevoke = await anonymous().get('/v1/display/feed').set('x-display-token', first.body.data.token);
    expect(afterRevoke.status).toBe(401);
  });

  it('never exposes client PII on a display feed', async () => {
    const display = await ownerA.post('/v1/sales-screen/displays').send({ name: 'PII display' });
    const preview = await ownerA.get(`/v1/sales-screen/displays/${display.body.data.id}/preview`);
    const serialized = JSON.stringify(preview.body.data);
    expect(serialized).not.toContain('0507770001');
    expect(serialized).not.toContain('Private Client');
  });

  it('refuses cron endpoints without the shared secret', async () => {
    expect((await anonymous().post('/v1/cron/jobs')).status).toBe(401);
    expect((await anonymous().post('/v1/cron/jobs').set('x-cron-secret', 'wrong')).status).toBe(401);
    expect((await anonymous().post('/v1/cron/jobs').set('x-cron-secret', process.env.CRON_SECRET)).status).toBe(200);
  });

  it('scopes an API key to its own organization and declared scopes', async () => {
    const created = await ownerA.post('/v1/integrations/api-keys').send({ name: 'Zapier', scopes: ['leads.create'] });
    const apiKey = created.body.data.api_key;

    const accepted = await anonymous()
      .post('/v1/public/leads')
      .set('x-api-key', apiKey)
      .send({ name: 'API Lead', phone: '0501112244', source: 'zapier' });
    expect(accepted.status).toBe(201);

    // The lead landed in tenant A only.
    const inB = await ownerB.get('/v1/leads?q=API');
    expect(inB.body.data).toHaveLength(0);

    // A scope the key does not hold is refused.
    const refused = await anonymous().get('/v1/deals').set('x-api-key', apiKey);
    expect(refused.status).toBe(403);
  });

  it('rejects an unknown API key', async () => {
    const response = await anonymous().post('/v1/public/leads').set('x-api-key', 'gvz_not_a_real_key').send({ name: 'X', phone: '0500000000' });
    expect(response.status).toBe(401);
  });
});

describe('permission boundaries', () => {
  let org;
  let agent;

  beforeAll(async () => {
    await prepareDatabase();
    await truncateAll();
    org = await createTestOrganization({ slug: 'perm-a' });
    agent = await signIn({ email: org.agent.email, password: org.password });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('lets an agent read leads but not manage the organization', async () => {
    expect((await agent.get('/v1/leads')).status).toBe(200);
    expect((await agent.patch('/v1/organization').send({ name: 'Renamed' })).status).toBe(403);
  });

  it('refuses to approve a listing without listings.approve', async () => {
    const listing = await agent.post('/v1/listings').send({
      offering_type: 'sale',
      property_type: 'apartment',
      title: 'Agent created listing',
      description: 'A listing created by an agent to check that approval is blocked without the right permission.',
      price: 900000,
      built_up_area: 700,
    });
    const response = await agent.post(`/v1/listings/${listing.body.data.listing.id}/approval`).send({ decision: 'approved' });
    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/listings.approve/);
  });

  it('refuses off-plan routes when the module is not enabled for that membership', async () => {
    const db = getDb();
    await db('organization_memberships').where('id', org.agent.membershipId).update({ modules: JSON.stringify(['ready']) });
    const fresh = await signIn({ email: org.agent.email, password: org.password });
    const response = await fresh.get('/v1/offplan/projects');
    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/offplan module/);
  });
});

describe('CSRF protection', () => {
  let org;
  let owner;

  beforeAll(async () => {
    await prepareDatabase();
    await truncateAll();
    org = await createTestOrganization({ slug: 'csrf-org' });
    owner = await signIn({ email: org.owner.email, password: org.password });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('rejects a cookie-authorized write without the CSRF header', async () => {
    const login = await anonymous().post('/v1/auth/login').send({ email: org.owner.email, password: org.password });
    const cookies = login.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');

    const withoutHeader = await anonymous().post('/v1/leads').set('cookie', cookies).send({ module: 'ready', purpose: 'buy', contact: { first_name: 'CSRF' } });
    expect(withoutHeader.status).toBe(403);
    expect(withoutHeader.body.error.message).toMatch(/CSRF/i);

    const csrf = cookies.split('; ').find((cookie) => cookie.startsWith('gvz_csrf=')).split('=')[1];
    const withHeader = await anonymous()
      .post('/v1/leads')
      .set('cookie', cookies)
      .set('x-csrf-token', decodeURIComponent(csrf))
      .send({ module: 'ready', purpose: 'buy', contact: { first_name: 'CSRF', identifiers: [{ identifier_type: 'phone', value: '0501110000' }] } });
    expect(withHeader.status).toBe(201);
  });

  it('still allows display pairing when a stale browser cookie is present', async () => {
    const display = await owner.post('/v1/sales-screen/displays').send({ name: 'CSRF display' });
    const pairing = await owner.post(`/v1/sales-screen/displays/${display.body.data.id}/pairing-code`).send({});
    const login = await anonymous().post('/v1/auth/login').send({ email: org.owner.email, password: org.password });
    const cookies = login.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');

    const response = await anonymous().post('/v1/display/pair').set('cookie', cookies).send({ code: pairing.body.data.code });
    expect(response.status).toBe(201);
  });
});
