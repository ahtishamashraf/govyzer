import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { serverEnvSchema } from './schema.js';

/**
 * Walks up from the working directory so a single repository-root .env works for every
 * workspace package without duplicating credentials per app.
 */
function loadEnvFiles() {
  const names = process.env.ENV_FILE ? [process.env.ENV_FILE] : ['.env.local', '.env'];
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    for (const name of names) {
      const candidate = path.isAbsolute(name) ? name : path.join(dir, name);
      if (fs.existsSync(candidate)) loadDotenv({ path: candidate, override: false });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

let cached = null;

/**
 * Loads and validates server configuration. Throws a readable aggregate error when the
 * environment is not deployable, so a misconfigured deployment fails fast instead of at
 * the first request.
 */
export function loadServerConfig({ reload = false, source = process.env } = {}) {
  if (cached && !reload) return cached;
  if (process.env.NODE_ENV !== 'production') loadEnvFiles();

  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid server environment configuration:\n${issues}`);
  }

  const env = parsed.data;
  const isProduction = env.APP_ENV === 'production';

  if (isProduction) {
    const required = [
      ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET !== 'dev-only-access-secret-change-me'],
      ['ENCRYPTION_KEYS', env.ENCRYPTION_KEYS.length > 0],
      ['CRON_SECRET', env.CRON_SECRET.length >= 16],
      ['INTERNAL_API_TOKEN', env.INTERNAL_API_TOKEN.length >= 16],
      ['S3_BUCKET', env.S3_BUCKET.length > 0],
      ['DATABASE_SSL', env.DATABASE_SSL === true],
      ['COOKIE_SECURE', env.COOKIE_SECURE === true],
    ].filter(([, ok]) => !ok);
    if (required.length > 0) {
      throw new Error(
        `Production configuration is incomplete: ${required.map(([key]) => key).join(', ')}`
      );
    }
  }

  cached = Object.freeze({
    env,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    database: {
      host: env.DATABASE_HOST,
      port: env.DATABASE_PORT,
      user: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD,
      database: env.DATABASE_NAME,
      ssl: env.DATABASE_SSL,
      sslRejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
      sslCa: env.DATABASE_SSL_CA,
      poolMin: env.DATABASE_POOL_MIN,
      poolMax: env.DATABASE_POOL_MAX,
      acquireTimeoutMs: env.DATABASE_ACQUIRE_TIMEOUT_MS,
      idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
      debug: env.DATABASE_DEBUG,
    },
  });
  return cached;
}

export function resetServerConfigCache() {
  cached = null;
}

export { serverEnvSchema, publicEnvSchema } from './schema.js';
