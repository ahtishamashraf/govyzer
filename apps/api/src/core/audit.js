import { getDb } from '@govyzer/database';
import { newId } from '@govyzer/domain';
import { redact } from './logger.js';

const MAX_DIFF_KEYS = 60;

/** Produces a small, redacted before/after diff safe for long term storage. */
export function safeDiff(before, after) {
  if (!before && !after) return { before: null, after: null };
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const beforeDiff = {};
  const afterDiff = {};
  let count = 0;
  for (const key of keys) {
    if (count >= MAX_DIFF_KEYS) break;
    const previous = before?.[key];
    const next = after?.[key];
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    beforeDiff[key] = previous ?? null;
    afterDiff[key] = next ?? null;
    count += 1;
  }
  return { before: redact(beforeDiff), after: redact(afterDiff) };
}

/** Appends an audit entry. Audit rows are never updated or deleted. */
export async function recordAudit({
  organizationId = '',
  actor = null,
  action,
  entityType,
  entityId = null,
  before = null,
  after = null,
  requestId = null,
  ipAddress = null,
  userAgent = null,
  source = 'api',
  trx = null,
}) {
  const db = trx ?? getDb();
  const diff = safeDiff(before, after);
  await db('audit_logs').insert({
    id: newId(),
    organization_id: organizationId ?? '',
    actor_user_id: actor?.userId ?? null,
    actor_membership_id: actor?.membershipId ?? null,
    actor_type: actor?.type ?? (actor?.userId ? 'user' : 'system'),
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_data: before ? JSON.stringify(diff.before) : null,
    after_data: after ? JSON.stringify(diff.after) : null,
    request_id: requestId,
    ip_address: ipAddress,
    user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
    source,
  });
}

export function auditFromRequest(req) {
  return {
    organizationId: req.actor?.organizationId ?? '',
    actor: req.actor ? { userId: req.actor.userId, membershipId: req.actor.membershipId, type: req.actor.type ?? 'user' } : null,
    requestId: req.requestId ?? null,
    ipAddress: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
  };
}
