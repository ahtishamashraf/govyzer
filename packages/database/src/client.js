import knexFactory from 'knex';
import { loadServerConfig } from '@govyzer/config';

let instance = null;

/**
 * Builds the knex configuration. Pool sizes stay small because the API runs on serverless
 * functions where every warm instance holds its own pool against RDS.
 */
export function buildKnexConfig(overrides = {}) {
  const { database } = loadServerConfig();
  const ssl = database.ssl
    ? {
        rejectUnauthorized: database.sslRejectUnauthorized,
        ...(database.sslCa ? { ca: database.sslCa.replace(/\\n/g, '\n') } : {}),
      }
    : undefined;

  return {
    client: 'mysql2',
    connection: {
      host: overrides.host ?? database.host,
      port: overrides.port ?? database.port,
      user: overrides.user ?? database.user,
      password: overrides.password ?? database.password,
      database: overrides.database ?? database.database,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: true,
      ...(ssl ? { ssl } : {}),
    },
    pool: {
      min: overrides.poolMin ?? database.poolMin,
      max: overrides.poolMax ?? database.poolMax,
      acquireTimeoutMillis: database.acquireTimeoutMs,
      idleTimeoutMillis: database.idleTimeoutMs,
      createRetryIntervalMillis: 200,
    },
    acquireConnectionTimeout: database.acquireTimeoutMs,
    debug: database.debug,
    migrations: {
      directory: new URL('../migrations', import.meta.url).pathname,
      tableName: 'knex_migrations',
      loadExtensions: ['.cjs'],
      disableTransactions: false,
    },
    seeds: {
      directory: new URL('../seeds', import.meta.url).pathname,
      loadExtensions: ['.cjs'],
    },
  };
}

/** Returns the process-wide knex instance, creating it on first use. */
export function getDb(overrides) {
  if (!instance) {
    instance = knexFactory(buildKnexConfig(overrides));
  }
  return instance;
}

export function createDb(overrides) {
  return knexFactory(buildKnexConfig(overrides));
}

export async function destroyDb() {
  if (instance) {
    await instance.destroy();
    instance = null;
  }
}
