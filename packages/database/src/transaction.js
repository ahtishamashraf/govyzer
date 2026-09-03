const RETRYABLE_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * Runs `handler` inside a transaction, retrying a bounded number of times when MySQL
 * reports a deadlock or lock-wait timeout. Reservation and inventory writes rely on this.
 */
export async function withTransaction(db, handler, { retries = 2, existing = null } = {}) {
  if (existing) return handler(existing);

  let attempt = 0;
  for (;;) {
    try {
      return await db.transaction((trx) => handler(trx));
    } catch (error) {
      const retryable = RETRYABLE_CODES.has(error?.code);
      if (!retryable || attempt >= retries) throw error;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

/** Locks a single row for update and returns it, or null when it does not exist. */
export async function lockRow(trx, table, where) {
  const row = await trx(table).where(where).forUpdate().first();
  return row ?? null;
}
