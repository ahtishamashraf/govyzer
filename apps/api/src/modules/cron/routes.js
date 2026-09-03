import { Router } from 'express';
import { getDb } from '@govyzer/database';
import { loadServerConfig } from '@govyzer/config';
import { newId, UnauthorizedError } from '@govyzer/domain';
import { handler } from '../../core/async-handler.js';
import { sendData } from '../../core/responses.js';
import { runJobBatch, enqueueJob } from '../../core/jobs.js';
import { processOutboxBatch } from '../../jobs/outbox-processor.js';
import { JOB_TYPES } from '../../jobs/index.js';
import { constantTimeEquals } from '../../core/crypto.js';
import { logger } from '../../core/logger.js';

/** Verifies the Vercel Cron secret (header or bearer) before any work is claimed. */
function requireCronSecret() {
  return (req, res, next) => {
    const { env } = loadServerConfig();
    if (!env.CRON_SECRET) return next(new UnauthorizedError('CRON_SECRET is not configured on this deployment'));
    const header = req.get('authorization');
    const provided = req.get('x-cron-secret') ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);
    if (!provided || !constantTimeEquals(provided, env.CRON_SECRET)) {
      return next(new UnauthorizedError('Invalid cron secret'));
    }
    return next();
  };
}

/**
 * Cron endpoints claim small bounded batches, respect a time budget and are safe to run
 * more than once — a duplicate invocation simply finds nothing left to claim.
 */
export function cronRoutes() {
  const router = Router();
  router.use(requireCronSecret());

  router.post(
    '/outbox',
    handler(async (req, res) => sendData(res, await processOutboxBatch({ limit: 100, budgetMs: 20_000 })))
  );

  router.post(
    '/jobs',
    handler(async (req, res) => {
      const queue = req.query.queue ? String(req.query.queue) : null;
      sendData(res, await runJobBatch({ queue, limit: 25, budgetMs: 25_000 }));
    })
  );

  router.post(
    '/sla',
    handler(async (req, res) => {
      const db = getDb();
      const due = await db('lead_sla_events').where('status', 'scheduled').where('due_at', '<=', new Date()).limit(200);
      for (const event of due) {
        await enqueueJob({
          organizationId: event.organization_id,
          jobType: JOB_TYPES.LEAD_SLA_CHECK,
          payload: { lead_id: event.lead_id, sla_event_id: event.id },
          dedupeKey: `sla-sweep:${event.id}`,
        });
      }
      sendData(res, { queued: due.length });
    })
  );

  router.post(
    '/expiries',
    handler(async (req, res) => {
      const db = getDb();
      const now = new Date();
      const [reservations, holds] = await Promise.all([
        db('reservations').whereIn('status', ['pending', 'confirmed', 'extended']).where('expires_at', '<=', now).limit(200),
        db('unit_holds').where('status', 'active').where('expires_at', '<=', now).limit(200),
      ]);
      for (const reservation of reservations) {
        await enqueueJob({
          organizationId: reservation.organization_id,
          jobType: JOB_TYPES.RESERVATION_EXPIRE,
          payload: { reservation_id: reservation.id },
          dedupeKey: `reservation-expire-sweep:${reservation.id}`,
        });
      }
      for (const hold of holds) {
        await enqueueJob({
          organizationId: hold.organization_id,
          jobType: JOB_TYPES.HOLD_EXPIRE,
          payload: { hold_id: hold.id },
          dedupeKey: `hold-expire-sweep:${hold.id}`,
        });
      }
      sendData(res, { reservations: reservations.length, holds: holds.length });
    })
  );

  router.post(
    '/webhooks',
    handler(async (req, res) => {
      const db = getDb();
      const deliveries = await db('webhook_deliveries')
        .where('status', 'pending')
        .where('run_after', '<=', new Date())
        .limit(100);
      for (const delivery of deliveries) {
        await enqueueJob({
          organizationId: delivery.organization_id,
          jobType: JOB_TYPES.WEBHOOK_DELIVER,
          payload: { delivery_id: delivery.id },
          dedupeKey: `webhook-deliver:${delivery.id}:${delivery.attempts}`,
        });
      }
      const receipts = await db('webhook_receipts').whereIn('status', ['received', 'failed']).where('attempts', '<', 5).limit(100);
      for (const receipt of receipts) {
        await enqueueJob({
          organizationId: receipt.organization_id,
          jobType: JOB_TYPES.WEBHOOK_PROCESS,
          payload: { receipt_id: receipt.id },
          dedupeKey: `webhook-process:${receipt.id}:${receipt.attempts}`,
        });
      }
      sendData(res, { deliveries: deliveries.length, receipts: receipts.length });
    })
  );

  router.post(
    '/portals',
    handler(async (req, res) => {
      const db = getDb();
      const accounts = await db('portal_accounts').where({ is_enabled: true }).whereNull('deleted_at').limit(100);
      for (const account of accounts) {
        await enqueueJob({
          organizationId: account.organization_id,
          jobType: JOB_TYPES.PORTAL_STATUS_REFRESH,
          payload: { portal_account_id: account.id },
          dedupeKey: `portal-status-sweep:${account.id}:${new Date().toISOString().slice(0, 13)}`,
        });
      }
      const stalled = await db('portal_publications').whereIn('status', ['queued']).limit(100);
      for (const publication of stalled) {
        await enqueueJob({
          organizationId: publication.organization_id,
          jobType: JOB_TYPES.PORTAL_PUBLISH,
          payload: { publication_id: publication.id },
          dedupeKey: `portal-publish-sweep:${publication.id}:${publication.attempts}`,
        });
      }
      sendData(res, { accounts: accounts.length, publications: stalled.length });
    })
  );

  router.post(
    '/workflows',
    handler(async (req, res) => {
      const db = getDb();
      const waiting = await db('workflow_runs').where('status', 'waiting').where('resume_at', '<=', new Date()).limit(100);
      for (const run of waiting) {
        await enqueueJob({
          organizationId: run.organization_id,
          jobType: JOB_TYPES.WORKFLOW_RESUME,
          payload: { run_id: run.id, entity_type: run.entity_type, entity_id: run.entity_id },
          dedupeKey: `workflow-resume-sweep:${run.id}`,
        });
      }
      sendData(res, { resumed: waiting.length });
    })
  );

  router.post(
    '/reminders',
    handler(async (req, res) => {
      const db = getDb();
      const window = new Date(Date.now() + 30 * 60 * 1000);
      const meetings = await db('meetings').where('status', 'scheduled').whereBetween('starts_at', [new Date(), window]).limit(200);
      const tasks = await db('tasks').where('status', 'open').whereNotNull('due_at').where('due_at', '<=', new Date()).limit(200);
      for (const meeting of meetings) {
        await enqueueJob({
          organizationId: meeting.organization_id,
          jobType: JOB_TYPES.REMINDER_DISPATCH,
          payload: { entity_type: 'meeting', entity_id: meeting.id },
          dedupeKey: `meeting-reminder-sweep:${meeting.id}`,
        });
      }
      for (const task of tasks) {
        await enqueueJob({
          organizationId: task.organization_id,
          jobType: JOB_TYPES.REMINDER_DISPATCH,
          payload: { entity_type: 'task', entity_id: task.id },
          dedupeKey: `task-reminder-sweep:${task.id}`,
        });
      }
      sendData(res, { meetings: meetings.length, tasks: tasks.length });
    })
  );

  router.post(
    '/reports',
    handler(async (req, res) => {
      const db = getDb();
      const schedules = await db('report_schedules').where('is_active', true).where('next_run_at', '<=', new Date()).limit(50);
      for (const schedule of schedules) {
        await enqueueJob({
          organizationId: schedule.organization_id,
          jobType: JOB_TYPES.REPORT_RUN,
          payload: { schedule_id: schedule.id },
          dedupeKey: `report:${schedule.id}:${new Date().toISOString().slice(0, 10)}`,
        });
        await db('report_schedules').where('id', schedule.id).update({ next_run_at: new Date(Date.now() + 24 * 60 * 60 * 1000) });
      }
      sendData(res, { queued: schedules.length });
    })
  );

  router.post(
    '/retention',
    handler(async (req, res) => {
      await enqueueJob({ jobType: JOB_TYPES.DATA_RETENTION, payload: {}, dedupeKey: `retention:${new Date().toISOString().slice(0, 10)}` });
      const result = await runJobBatch({ limit: 5, budgetMs: 20_000 });
      logger.info('cron_retention', result);
      sendData(res, result);
    })
  );

  return router;
}
