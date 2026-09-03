import { getDb } from '@govyzer/database';
import { newId } from '@govyzer/domain';
import { logger } from './logger.js';

const handlers = new Map();

export function registerJobHandler(jobType, handler) {
  handlers.set(jobType, handler);
}

export function getJobHandler(jobType) {
  return handlers.get(jobType) ?? null;
}

export function registeredJobTypes() {
  return [...handlers.keys()];
}

/**
 * Enqueues work. `dedupeKey` makes enqueueing idempotent, which matters because cron
 * endpoints and webhooks can both ask for the same work.
 */
export async function enqueueJob({
  organizationId = '',
  jobType,
  payload = {},
  queue = 'default',
  runAfter = null,
  priority = 100,
  maxAttempts = 5,
  dedupeKey = null,
  idempotencyKey = null,
  trx = null,
}) {
  const db = trx ?? getDb();
  const id = newId();
  const row = {
    id,
    organization_id: organizationId ?? '',
    queue,
    job_type: jobType,
    payload: JSON.stringify(payload),
    status: 'queued',
    priority,
    max_attempts: maxAttempts,
    run_after: runAfter ?? db.fn.now(),
    dedupe_key: dedupeKey,
    idempotency_key: idempotencyKey,
  };

  if (dedupeKey) {
    const existing = await db('jobs')
      .where({ queue, dedupe_key: dedupeKey })
      .whereIn('status', ['queued', 'running'])
      .first('id');
    if (existing) return existing.id;
    try {
      await db('jobs').insert(row);
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        const duplicate = await db('jobs').where({ queue, dedupe_key: dedupeKey }).first('id');
        return duplicate?.id ?? null;
      }
      throw error;
    }
    return id;
  }

  await db('jobs').insert(row);
  return id;
}

/** Claims a bounded batch using an atomic conditional update, safe under concurrency. */
export async function claimJobs(db, { queue = null, limit = 20, workerId, leaseSeconds = 120 } = {}) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);

  let candidateQuery = db('jobs')
    .whereIn('status', ['queued', 'retry'])
    .where('run_after', '<=', now)
    .where((builder) => builder.whereNull('locked_until').orWhere('locked_until', '<', now))
    .orderBy([{ column: 'priority', order: 'asc' }, { column: 'run_after', order: 'asc' }])
    .limit(limit);
  if (queue) candidateQuery = candidateQuery.where('queue', queue);

  const ids = await candidateQuery.pluck('id');
  if (ids.length === 0) return [];

  await db('jobs')
    .whereIn('id', ids)
    .where((builder) => builder.whereNull('locked_until').orWhere('locked_until', '<', now))
    .update({ status: 'running', locked_by: workerId, locked_until: leaseUntil, started_at: now });

  return db('jobs').whereIn('id', ids).where('locked_by', workerId);
}

export async function completeJob(db, job, result = null) {
  await db('jobs').where('id', job.id).update({
    status: 'completed',
    finished_at: db.fn.now(),
    locked_by: null,
    locked_until: null,
    last_error: null,
  });
  await db('job_attempts').insert({
    id: newId(),
    job_id: job.id,
    attempt_number: Number(job.attempts ?? 0) + 1,
    status: 'completed',
    duration_ms: result?.durationMs ?? null,
    worker_id: job.locked_by ?? null,
  });
}

export async function failJob(db, job, error) {
  const attempts = Number(job.attempts ?? 0) + 1;
  const exhausted = attempts >= Number(job.max_attempts ?? 5);
  const backoffMs = Math.min(2 ** attempts * 1000, 30 * 60 * 1000);

  await db('job_attempts').insert({
    id: newId(),
    job_id: job.id,
    attempt_number: attempts,
    status: exhausted ? 'dead' : 'failed',
    worker_id: job.locked_by ?? null,
    error_message: String(error?.message ?? error).slice(0, 1000),
    error_stack: error?.stack ? String(error.stack).slice(0, 4000) : null,
  });

  await db('jobs')
    .where('id', job.id)
    .update({
      status: exhausted ? 'dead' : 'retry',
      attempts,
      run_after: new Date(Date.now() + backoffMs),
      locked_by: null,
      locked_until: null,
      last_error: String(error?.message ?? error).slice(0, 1000),
      finished_at: exhausted ? db.fn.now() : null,
    });

  if (exhausted) {
    await db('dead_letter_jobs').insert({
      id: newId(),
      organization_id: job.organization_id ?? '',
      origin: 'job',
      origin_id: job.id,
      queue: job.queue,
      job_type: job.job_type,
      payload: typeof job.payload === 'string' ? job.payload : JSON.stringify(job.payload ?? {}),
      attempts,
      last_error: String(error?.message ?? error).slice(0, 2000),
      status: 'open',
    });
  }
}

/** Runs one bounded batch. Cron endpoints call this with a time budget. */
export async function runJobBatch({ queue = null, limit = 20, workerId = newId(), budgetMs = 25_000 } = {}) {
  const db = getDb();
  const startedAt = Date.now();
  const jobs = await claimJobs(db, { queue, limit, workerId });
  const results = { claimed: jobs.length, completed: 0, failed: 0, skipped: 0 };

  for (const job of jobs) {
    if (Date.now() - startedAt > budgetMs) {
      await db('jobs').where('id', job.id).update({ status: 'queued', locked_by: null, locked_until: null });
      results.skipped += 1;
      continue;
    }
    const handler = getJobHandler(job.job_type);
    if (!handler) {
      await failJob(db, job, new Error(`No handler registered for job type ${job.job_type}`));
      results.failed += 1;
      continue;
    }
    const attemptStart = Date.now();
    try {
      const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      await handler({ job, payload, db, organizationId: job.organization_id || null });
      await completeJob(db, job, { durationMs: Date.now() - attemptStart });
      results.completed += 1;
    } catch (error) {
      logger.error('job_failed', { job_id: job.id, job_type: job.job_type, error: error.message });
      await failJob(db, job, error);
      results.failed += 1;
    }
  }
  return results;
}
