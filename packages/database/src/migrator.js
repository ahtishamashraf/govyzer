import { getDb } from './client.js';

export async function migrateLatest(db = getDb()) {
  const [batch, applied] = await db.migrate.latest();
  return { batch, applied };
}

export async function migrateRollback(db = getDb(), all = false) {
  const [batch, reverted] = await db.migrate.rollback(undefined, all);
  return { batch, reverted };
}

export async function migrationStatus(db = getDb()) {
  const [completed, pending] = await db.migrate.list();
  return {
    completed: completed.map((entry) => entry.name ?? entry),
    pending: pending.map((entry) => entry.file ?? entry),
  };
}

export async function runSeeds(db = getDb()) {
  const [seeds] = await db.seed.run();
  return seeds;
}

/**
 * Drops every table then re-applies migrations. Refuses to run against production.
 */
export async function resetDatabase(db = getDb()) {
  const { loadServerConfig } = await import('@govyzer/config');
  const { isProduction } = loadServerConfig();
  if (isProduction) throw new Error('resetDatabase is not allowed when APP_ENV=production');

  const dbName = db.client.config.connection.database;
  const rows = await db('information_schema.tables')
    .select('table_name as name')
    .where('table_schema', dbName);
  if (rows.length > 0) {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const row of rows) {
      await db.raw('DROP TABLE IF EXISTS ??', [row.name]);
    }
    await db.raw('SET FOREIGN_KEY_CHECKS = 1');
  }
  return migrateLatest(db);
}
