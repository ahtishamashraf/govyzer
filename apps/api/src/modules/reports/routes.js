import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import { rateLimit } from '../../core/rate-limit.js';
import * as service from './service.js';

const filterSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  module: z.enum(['ready', 'offplan']).optional(),
  project_id: idSchema.optional(),
  branch_id: idSchema.optional(),
  team_id: idSchema.optional(),
});

export function reportRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get('/', requirePermission('reports.read'), handler(async (req, res) => sendData(res, service.listReports(req.actor))));

  router.get(
    '/dashboards/executive',
    requirePermission('reports.read'),
    validate({ query: filterSchema }),
    handler(async (req, res) => sendData(res, await service.executiveDashboard({ organizationId: req.actor.organizationId, actor: req.actor, filters: req.validatedQuery })))
  );

  router.get(
    '/dashboards/ready',
    requirePermission('reports.read'),
    validate({ query: filterSchema }),
    handler(async (req, res) => sendData(res, await service.readyDashboard({ organizationId: req.actor.organizationId, actor: req.actor, filters: req.validatedQuery })))
  );

  router.get(
    '/dashboards/offplan',
    requirePermission('reports.read'),
    validate({ query: filterSchema }),
    handler(async (req, res) => sendData(res, await service.offplanDashboard({ organizationId: req.actor.organizationId, actor: req.actor, filters: req.validatedQuery })))
  );

  router.get(
    '/:code',
    requirePermission('reports.read'),
    validate({ params: z.object({ code: z.string().max(60) }), query: filterSchema }),
    handler(async (req, res) =>
      sendData(res, await service.runReport({ organizationId: req.actor.organizationId, code: req.validatedParams.code, filters: req.validatedQuery, actor: req.actor }))
    )
  );

  router.post(
    '/exports',
    requirePermission('data.export'),
    rateLimit({ name: 'exports', max: 20, windowMs: 60_000 }),
    validate({ body: z.object({ entity_type: z.enum(['leads', 'contacts', 'listings', 'units', 'deals', 'reservations']), filters: z.record(z.string(), z.unknown()).default({}), format: z.enum(['csv']).default('csv') }) }),
    handler(async (req, res) =>
      sendData(res, await service.createExport({ organizationId: req.actor.organizationId, actor: req.actor, entityType: req.validatedBody.entity_type, filters: req.validatedBody.filters, format: req.validatedBody.format }), { status: 201 })
    )
  );

  router.get(
    '/exports/list',
    requirePermission('data.export'),
    validate({ query: paginationSchema }),
    handler(async (req, res) => {
      const rows = await getDb()('data_exports').where('organization_id', req.actor.organizationId).orderBy('created_at', 'desc').limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.get(
    '/exports/:id/download',
    requirePermission('data.export'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => sendData(res, await service.exportDownloadUrl({ organizationId: req.actor.organizationId, exportId: req.validatedParams.id })))
  );

  router.post(
    '/schedules',
    requirePermission('reports.schedule'),
    validate({
      body: z.object({
        report_code: z.string().max(60),
        name: z.string().max(180),
        cron_expression: z.string().max(60),
        timezone: z.string().max(64).default('Asia/Dubai'),
        filters: z.record(z.string(), z.unknown()).default({}),
        recipients: z.array(z.string().email()).min(1),
        format: z.enum(['csv', 'xlsx']).default('csv'),
      }),
    }),
    handler(async (req, res) => {
      const db = getDb();
      const { newId } = await import('@govyzer/domain');
      const id = newId();
      await db('report_schedules').insert({
        id,
        organization_id: req.actor.organizationId,
        ...req.validatedBody,
        filters: JSON.stringify(req.validatedBody.filters),
        recipients: JSON.stringify(req.validatedBody.recipients),
        next_run_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        created_by: req.actor.membershipId,
      });
      sendData(res, await db('report_schedules').where('id', id).first(), { status: 201 });
    })
  );

  return router;
}
