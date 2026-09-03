import { getDb } from '@govyzer/database';
import { loadServerConfig } from '@govyzer/config';
import { RateLimitError } from '@govyzer/domain';

/**
 * Database backed fixed-window limiter. Serverless functions do not share memory, so the
 * counter lives in MySQL where every instance sees the same window.
 */
export async function consumeRateLimit({ key, max, windowMs, db = getDb() }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowMs);

  const existing = await db('rate_limit_buckets').where('bucket_key', key).first();
  if (!existing || new Date(existing.expires_at) <= now) {
    await db('rate_limit_buckets')
      .insert({ bucket_key: key, hits: 1, window_started_at: now, expires_at: expiresAt })
      .onConflict('bucket_key')
      .merge({ hits: 1, window_started_at: now, expires_at: expiresAt });
    return { allowed: true, remaining: max - 1, resetAt: expiresAt };
  }

  const hits = Number(existing.hits) + 1;
  await db('rate_limit_buckets').where('bucket_key', key).increment('hits', 1);
  const allowed = hits <= max;
  return {
    allowed,
    remaining: Math.max(max - hits, 0),
    resetAt: new Date(existing.expires_at),
  };
}

export function rateLimit({ name, max = null, windowMs = null, keyResolver = null }) {
  return async function rateLimitMiddleware(req, res, next) {
    try {
      const { env } = loadServerConfig();
      const limit = max ?? env.RATE_LIMIT_MAX_REQUESTS;
      const window = windowMs ?? env.RATE_LIMIT_WINDOW_MS;
      const identity =
        keyResolver?.(req) ??
        req.actor?.userId ??
        req.actor?.organizationId ??
        req.ip ??
        'anonymous';
      const key = `${name}:${identity}`.slice(0, 190);

      const result = await consumeRateLimit({ key, max: limit, windowMs: window });
      res.setHeader('x-ratelimit-limit', String(limit));
      res.setHeader('x-ratelimit-remaining', String(result.remaining));
      res.setHeader('x-ratelimit-reset', String(Math.floor(result.resetAt.getTime() / 1000)));

      if (!result.allowed) {
        const retryAfter = Math.max(Math.ceil((result.resetAt.getTime() - Date.now()) / 1000), 1);
        res.setHeader('retry-after', String(retryAfter));
        throw new RateLimitError(retryAfter);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
