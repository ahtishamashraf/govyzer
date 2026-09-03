import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@govyzer/database';
import { closeDatabase, createTestOrganization, prepareDatabase, truncateAll } from '../helpers/db.js';
import { createLead } from '../../apps/api/src/modules/leads/service.js';
import { getContact } from '../../apps/api/src/modules/contacts/service.js';
import { createRepository } from '../../apps/api/src/core/repository.js';

describe('tenant isolation', () => {
  let orgA;
  let orgB;

  beforeAll(async () => {
    await prepareDatabase();
    await truncateAll();
    orgA = await createTestOrganization({ slug: 'tenant-a' });
    orgB = await createTestOrganization({ slug: 'tenant-b' });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('never returns another organization record by id', async () => {
    const created = await createLead({
      organizationId: orgA.organizationId,
      actor: orgA.actor,
      payload: { module: 'ready', purpose: 'buy', contact: { first_name: 'A', identifiers: [{ identifier_type: 'phone', value: '0500000001' }] } },
    });

    const leads = createRepository('leads', { versioned: true });
    expect(await leads.findById(orgA.organizationId, created.lead.id)).not.toBeNull();
    expect(await leads.findById(orgB.organizationId, created.lead.id)).toBeNull();
    await expect(getContact({ organizationId: orgB.organizationId, id: created.contact.id, actor: orgB.actor })).rejects.toThrow(/not found/i);
  });

  it('refuses to build a query without an organization id', async () => {
    const leads = createRepository('leads');
    await expect(leads.findById(null, 'anything')).rejects.toThrow(/without an organization id/);
  });

  it('keeps counts and aggregates scoped to one tenant', async () => {
    await createLead({
      organizationId: orgB.organizationId,
      actor: orgB.actor,
      payload: { module: 'ready', purpose: 'rent', contact: { first_name: 'B', identifiers: [{ identifier_type: 'phone', value: '0500000002' }] } },
    });
    const leads = createRepository('leads');
    expect(await leads.count(orgA.organizationId)).toBe(1);
    expect(await leads.count(orgB.organizationId)).toBe(1);
  });

  it('scopes reference sequences per tenant so numbering never collides', async () => {
    const db = getDb();
    const [a] = await db('leads').where('organization_id', orgA.organizationId).pluck('reference');
    const [b] = await db('leads').where('organization_id', orgB.organizationId).pluck('reference');
    expect(a.startsWith(orgA.organization.reference_prefix)).toBe(true);
    expect(b.startsWith(orgB.organization.reference_prefix)).toBe(true);
  });

  it('isolates identifiers so the same phone number can exist in both tenants', async () => {
    const resultA = await createLead({
      organizationId: orgA.organizationId,
      actor: orgA.actor,
      payload: { module: 'ready', purpose: 'buy', contact: { first_name: 'Shared', identifiers: [{ identifier_type: 'phone', value: '0509999999' }] } },
    });
    const resultB = await createLead({
      organizationId: orgB.organizationId,
      actor: orgB.actor,
      payload: { module: 'ready', purpose: 'buy', contact: { first_name: 'Shared', identifiers: [{ identifier_type: 'phone', value: '0509999999' }] } },
    });
    expect(resultA.contact.id).not.toBe(resultB.contact.id);
  });
});
