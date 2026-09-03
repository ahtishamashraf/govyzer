import { getDb } from '@govyzer/database';
import { buildReference, DEFAULT_REFERENCE_PATTERNS } from '@govyzer/domain';

/**
 * Allocates the next reference number for a tenant/entity. The counter row is locked for
 * the duration of the transaction so two concurrent creates never share a number.
 */
export async function nextReference({
  trx = null,
  organizationId,
  entity,
  prefix = 'GVZ',
  pattern = null,
  periodic = true,
  date = new Date(),
}) {
  const db = trx ?? getDb();
  const template = pattern ?? DEFAULT_REFERENCE_PATTERNS[entity] ?? '{PREFIX}-{SEQ}';
  const period = periodic && /\{YY|\{MM/.test(template)
    ? `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    : '';

  await db('reference_sequences')
    .insert({ organization_id: organizationId, entity, period, current_value: 0 })
    .onConflict(['organization_id', 'entity', 'period'])
    .ignore();

  const row = await db('reference_sequences')
    .where({ organization_id: organizationId, entity, period })
    .modify((query) => {
      if (trx) query.forUpdate();
    })
    .first();

  const next = Number(row?.current_value ?? 0) + 1;
  await db('reference_sequences')
    .where({ organization_id: organizationId, entity, period })
    .update({ current_value: next, updated_at: db.fn.now() });

  return buildReference({ entity, prefix, sequence: next, date, pattern: template });
}
