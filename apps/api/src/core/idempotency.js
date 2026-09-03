import { getDb } from '@govyzer/database';
import { newId, ConflictError } from '@govyzer/domain';
import { sha256 } from './crypto.js';

const DEFAULT_TTL_HOURS = 24;

/**
 * Express middleware implementing the `Idempotency-Key` header. A replay with the same
 * body returns the stored response; a replay with a different body is rejected.
 */
export function idempotency(scope, { ttlHours = DEFAULT_TTL_HOURS } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.get('idempotency-key');
    if (!key) return next();

    const db = getDb();
    const organizationId = req.actor?.organizationId ?? '';
    const requestHash = sha256(JSON.stringify(req.body ?? {}));
    const existing = await db('idempotency_keys')
      .where({ organization_id: organizationId, scope, idempotency_key: key })
      .first();

    if (existing) {
      if (existing.request_hash !== requestHash) {
        return next(
          new ConflictError('This idempotency key was already used with a different request body')
        );
      }
      if (existing.status === 'completed') {
        res.setHeader('idempotency-replayed', 'true');
        return res.status(existing.response_status ?? 200).json(
          typeof existing.response_body === 'string'
            ? JSON.parse(existing.response_body)
            : existing.response_body
        );
      }
      return next(new ConflictError('A request with this idempotency key is still in progress'));
    }

    await db('idempotency_keys').insert({
      id: newId(),
      organization_id: organizationId,
      scope,
      idempotency_key: key,
      request_hash: requestHash,
      status: 'in_progress',
      expires_at: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
    });

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        db('idempotency_keys')
          .where({ organization_id: organizationId, scope, idempotency_key: key })
          .update({ status: 'completed', response_status: res.statusCode, response_body: JSON.stringify(body) })
          .catch(() => {});
      } else {
        db('idempotency_keys')
          .where({ organization_id: organizationId, scope, idempotency_key: key })
          .delete()
          .catch(() => {});
      }
      return originalJson(body);
    };
    next();
  };
}
