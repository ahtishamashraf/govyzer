import { getDb, destroyDb, migrateLatest } from '@govyzer/database';
import { newId } from '@govyzer/domain';
import bcrypt from 'bcryptjs';
import { ensurePlatformCatalogue, provisionOrganizationDefaults } from '../../apps/api/src/modules/organizations/provisioning.js';

let prepared = false;

/** Applies migrations once per test run against the disposable test database. */
export async function prepareDatabase() {
  if (prepared) return getDb();
  const db = getDb();
  await migrateLatest(db);
  prepared = true;
  return db;
}

export async function truncateAll() {
  const db = getDb();
  const dbName = db.client.config.connection.database;
  const rows = await db('information_schema.tables').select('table_name as name').where('table_schema', dbName);
  await db.raw('SET FOREIGN_KEY_CHECKS = 0');
  for (const row of rows) {
    if (row.name === 'knex_migrations' || row.name === 'knex_migrations_lock') continue;
    await db.raw('TRUNCATE TABLE ??', [row.name]);
  }
  await db.raw('SET FOREIGN_KEY_CHECKS = 1');
}

export async function closeDatabase() {
  await destroyDb();
  prepared = false;
}

/**
 * Creates a fully provisioned organization with an owner and an agent so tests can act as
 * either. Returns ids plus a ready-to-use actor object.
 */
export async function createTestOrganization({ slug = `test-${newId().slice(-8).toLowerCase()}`, modules = ['ready', 'offplan', 'sales_screen'], password = 'TestPassword!2026' } = {}) {
  const db = getDb();
  const passwordHash = await bcrypt.hash(password, 4);

  const organization = {
    id: newId(),
    name: `Org ${slug}`,
    slug,
    status: 'active',
    country: 'AE',
    default_locale: 'en',
    default_currency: 'AED',
    timezone: 'Asia/Dubai',
    reference_prefix: slug.slice(0, 4).toUpperCase(),
    commission_base: 'gross_before_vat',
    vat_percentage: 5,
  };

  await db.transaction(async (trx) => {
    await ensurePlatformCatalogue(trx);
    await trx('organizations').insert(organization);
    organization.defaults = await provisionOrganizationDefaults(trx, organization, { modules });
  });

  const ownerUserId = newId();
  await db('users').insert({
    id: ownerUserId,
    email: `owner@${slug}.test`,
    password_hash: passwordHash,
    first_name: 'Owner',
    last_name: 'User',
    status: 'active',
    email_verified_at: db.fn.now(),
  });

  const agentUserId = newId();
  await db('users').insert({
    id: agentUserId,
    email: `agent@${slug}.test`,
    password_hash: passwordHash,
    first_name: 'Agent',
    last_name: 'User',
    status: 'active',
    email_verified_at: db.fn.now(),
  });

  const ownerMembershipId = await addMembership(db, { organization, userId: ownerUserId, roleCode: 'org_owner', modules: [...modules, 'finance', 'admin'], recordScope: 'organization' });
  const agentMembershipId = await addMembership(db, { organization, userId: agentUserId, roleCode: 'agent', modules, recordScope: 'assigned' });

  return {
    organization,
    organizationId: organization.id,
    password,
    owner: { userId: ownerUserId, membershipId: ownerMembershipId, email: `owner@${slug}.test` },
    agent: { userId: agentUserId, membershipId: agentMembershipId, email: `agent@${slug}.test` },
    actor: buildActor({ organization, membershipId: ownerMembershipId, userId: ownerUserId }),
  };
}

async function addMembership(db, { organization, userId, roleCode, modules, recordScope }) {
  const membershipId = newId();
  await db('organization_memberships').insert({
    id: membershipId,
    organization_id: organization.id,
    user_id: userId,
    branch_id: organization.defaults.branchId,
    status: 'active',
    record_scope: recordScope,
    modules: JSON.stringify(modules),
    accepted_at: db.fn.now(),
  });
  const role = await db('roles').where({ organization_id: '', code: roleCode }).first('id');
  await db('membership_roles').insert({ membership_id: membershipId, role_id: role.id });
  return membershipId;
}

export function buildActor({ organization, membershipId, userId, permissions = null, recordScope = 'organization' }) {
  return {
    type: 'user',
    userId,
    organizationId: organization.id,
    membershipId,
    isPlatformAdmin: false,
    permissions: new Set(permissions ?? ['*']),
    modules: ['ready', 'offplan', 'sales_screen', 'finance', 'admin'],
    recordScope,
    referencePrefix: organization.reference_prefix,
    vatPercentage: 5,
    teamId: null,
    branchId: organization.defaults?.branchId ?? null,
    managerMembershipId: null,
  };
}
