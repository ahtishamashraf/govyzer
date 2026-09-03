import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, createTestOrganization, prepareDatabase, truncateAll } from '../helpers/db.js';
import { anonymous, signIn } from '../helpers/api.js';

describe('authentication API', () => {
  let org;

  beforeAll(async () => {
    await prepareDatabase();
    await truncateAll();
    org = await createTestOrganization({ slug: 'auth-api' });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('registers an organization and returns a session', async () => {
    const response = await anonymous()
      .post('/v1/auth/register')
      .send({
        organization_name: 'Fresh Realty',
        organization_slug: 'fresh-realty',
        first_name: 'New',
        last_name: 'Owner',
        email: 'new-owner@fresh.test',
        password: 'StrongPassword!2026',
        modules: ['ready'],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.organization.slug).toBe('fresh-realty');
    expect(response.body.data.permissions.length).toBeGreaterThan(10);
    expect(response.headers['set-cookie'].join(';')).toMatch(/gvz_at=/);
  });

  it('rejects a weak password with field level detail', async () => {
    const response = await anonymous()
      .post('/v1/auth/register')
      .send({ organization_name: 'Weak', organization_slug: 'weak-co', first_name: 'A', last_name: 'B', email: 'weak@weak.test', password: 'short' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details.some((detail) => detail.path === 'password')).toBe(true);
  });

  it('refuses a duplicate workspace address', async () => {
    const response = await anonymous()
      .post('/v1/auth/register')
      .send({ organization_name: 'Copy', organization_slug: 'fresh-realty', first_name: 'A', last_name: 'B', email: 'copy@copy.test', password: 'StrongPassword!2026' });
    expect(response.status).toBe(422);
  });

  it('rejects a bad password without leaking whether the account exists', async () => {
    const unknown = await anonymous().post('/v1/auth/login').send({ email: 'nobody@nowhere.test', password: 'StrongPassword!2026' });
    const wrong = await anonymous().post('/v1/auth/login').send({ email: org.owner.email, password: 'WrongPassword!2026' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('requires authentication for protected routes', async () => {
    const response = await anonymous().get('/v1/leads');
    expect(response.status).toBe(401);
  });

  it('rejects an invalid bearer token', async () => {
    const response = await anonymous().get('/v1/leads').set('authorization', 'Bearer not-a-real-token');
    expect(response.status).toBe(401);
  });

  it('returns the actor with permissions and modules', async () => {
    const owner = await signIn({ email: org.owner.email, password: org.password });
    const response = await owner.get('/v1/auth/me');
    expect(response.status).toBe(200);
    expect(response.body.data.modules).toContain('ready');
    expect(response.body.data.organization.id).toBe(org.organizationId);
  });

  it('always returns success for a forgotten password request', async () => {
    const response = await anonymous().post('/v1/auth/forgot-password').send({ email: 'unknown@nowhere.test' });
    expect(response.status).toBe(200);
    expect(response.body.data.requested).toBe(true);
  });

  it('lists and revokes sessions', async () => {
    const owner = await signIn({ email: org.owner.email, password: org.password });
    const sessions = await owner.get('/v1/auth/sessions');
    expect(sessions.status).toBe(200);
    const target = sessions.body.data[0];
    const revoked = await owner.delete(`/v1/auth/sessions/${target.id}`);
    expect(revoked.status).toBe(204);
  });

  it('reports health, readiness and version', async () => {
    expect((await anonymous().get('/health')).status).toBe(200);
    expect((await anonymous().get('/ready')).status).toBe(200);
    expect((await anonymous().get('/version')).body.data.name).toBe('govyzer-api');
  });
});
