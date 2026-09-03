import { Router } from 'express';
import { z } from 'zod';
import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError, WORKFLOW_TRIGGERS, WORKFLOW_ACTIONS } from '@govyzer/domain';
import { workflowSchema, workflowTestSchema, idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';
import { runWorkflow, evaluateConditions } from './engine.js';

export function workflowRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/catalogue',
    requirePermission('workflows.read'),
    handler(async (req, res) =>
      sendData(res, {
        triggers: WORKFLOW_TRIGGERS,
        actions: WORKFLOW_ACTIONS,
        operators: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null', 'is_not_null'],
      })
    )
  );

  router.get(
    '/',
    requirePermission('workflows.read'),
    validate({ query: paginationSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const workflows = await db('workflow_definitions').where('organization_id', req.actor.organizationId).whereNull('deleted_at').orderBy('name');
      const versions = workflows.length
        ? await db('workflow_versions').where('organization_id', req.actor.organizationId).whereIn('workflow_id', workflows.map((workflow) => workflow.id)).orderBy('version_number', 'desc')
        : [];
      sendList(
        res,
        workflows.map((workflow) => ({
          ...workflow,
          versions: versions.filter((version) => version.workflow_id === workflow.id).map(({ actions, conditions, trigger_config: triggerConfig, ...rest }) => rest),
          current_version: versions.find((version) => version.id === workflow.current_version_id) ?? null,
        })),
        { page: 1, perPage: workflows.length, total: workflows.length }
      );
    })
  );

  router.post(
    '/',
    requirePermission('workflows.manage'),
    validate({ body: workflowSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { trigger_config: triggerConfig, conditions, actions, change_note: changeNote, ...workflow } = req.validatedBody;
      const workflowId = newId();
      const versionId = newId();

      await withTransaction(db, async (trx) => {
        await trx('workflow_definitions').insert({
          id: workflowId,
          organization_id: req.actor.organizationId,
          ...workflow,
          status: 'draft',
          current_version_id: versionId,
          is_enabled: false,
          created_by: req.actor.membershipId,
        });
        await trx('workflow_versions').insert({
          id: versionId,
          organization_id: req.actor.organizationId,
          workflow_id: workflowId,
          version_number: 1,
          trigger_config: JSON.stringify(triggerConfig),
          conditions: JSON.stringify(conditions),
          actions: JSON.stringify(actions),
          status: 'draft',
          change_note: changeNote ?? 'initial version',
        });
      });
      await recordAudit({ ...auditFromRequest(req), action: 'workflow.created', entityType: 'workflow_definition', entityId: workflowId, after: { name: workflow.name } });
      sendData(res, await db('workflow_definitions').where('id', workflowId).first(), { status: 201 });
    })
  );

  router.post(
    '/:id/versions',
    requirePermission('workflows.manage'),
    validate({ params: z.object({ id: idSchema }), body: workflowSchema.partial({ name: true, code: true, trigger_type: true }) }),
    handler(async (req, res) => {
      const db = getDb();
      const workflow = await db('workflow_definitions').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!workflow) throw new NotFoundError('Workflow');
      const [{ max_version: maxVersion }] = await db('workflow_versions').where('workflow_id', workflow.id).max({ max_version: 'version_number' });

      const versionId = newId();
      await db('workflow_versions').insert({
        id: versionId,
        organization_id: req.actor.organizationId,
        workflow_id: workflow.id,
        version_number: Number(maxVersion ?? 0) + 1,
        trigger_config: JSON.stringify(req.validatedBody.trigger_config ?? {}),
        conditions: JSON.stringify(req.validatedBody.conditions ?? []),
        actions: JSON.stringify(req.validatedBody.actions ?? []),
        status: 'draft',
        change_note: req.validatedBody.change_note ?? null,
      });
      sendData(res, await db('workflow_versions').where('id', versionId).first(), { status: 201 });
    })
  );

  router.post(
    '/versions/:id/publish',
    requirePermission('workflows.manage'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const version = await db('workflow_versions').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!version) throw new NotFoundError('Workflow version');
      await withTransaction(db, async (trx) => {
        await trx('workflow_versions').where('id', version.id).update({
          status: 'published',
          published_by_membership_id: req.actor.membershipId,
          published_at: trx.fn.now(),
        });
        await trx('workflow_definitions').where('id', version.workflow_id).update({
          current_version_id: version.id,
          status: 'published',
          is_enabled: true,
          updated_at: trx.fn.now(),
        });
      });
      await recordAudit({ ...auditFromRequest(req), action: 'workflow.published', entityType: 'workflow_version', entityId: version.id });
      sendData(res, await db('workflow_versions').where('id', version.id).first());
    })
  );

  router.post(
    '/:id/toggle',
    requirePermission('workflows.manage'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ enabled: z.boolean() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const updated = await db('workflow_definitions')
        .where({ id: req.validatedParams.id, organization_id: req.actor.organizationId })
        .update({ is_enabled: req.validatedBody.enabled, updated_at: db.fn.now() });
      if (updated === 0) throw new NotFoundError('Workflow');
      sendData(res, await db('workflow_definitions').where('id', req.validatedParams.id).first());
    })
  );

  router.post(
    '/:id/test',
    requirePermission('workflows.manage'),
    validate({ params: z.object({ id: idSchema }), body: workflowTestSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const workflow = await db('workflow_definitions').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!workflow) throw new NotFoundError('Workflow');
      const version = await db('workflow_versions').where('id', workflow.current_version_id).first();
      const conditions = typeof version.conditions === 'string' ? JSON.parse(version.conditions ?? '[]') : version.conditions;

      const evaluation = evaluateConditions(conditions ?? [], req.validatedBody.sample);
      const result = await runWorkflow({
        db,
        organizationId: req.actor.organizationId,
        versionId: version.id,
        entityType: req.validatedBody.entity_type ?? workflow.entity_type ?? 'lead',
        entityId: req.validatedBody.sample?.entity_id ?? newId(),
        triggerPayload: req.validatedBody.sample,
        isTestRun: true,
      });
      sendData(res, { evaluation, result });
    })
  );

  router.get(
    '/runs',
    requirePermission('workflows.read'),
    validate({ query: paginationSchema.extend({ workflow_id: idSchema.optional(), status: z.string().max(24).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('workflow_runs').where('organization_id', req.actor.organizationId);
      if (req.validatedQuery.workflow_id) query = query.where('workflow_id', req.validatedQuery.workflow_id);
      if (req.validatedQuery.status) query = query.where('status', req.validatedQuery.status);
      const rows = await query.orderBy('started_at', 'desc').limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.get(
    '/runs/:id',
    requirePermission('workflows.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const run = await db('workflow_runs').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!run) throw new NotFoundError('Workflow run');
      const actions = await db('workflow_action_runs').where({ organization_id: req.actor.organizationId, run_id: run.id }).orderBy('position');
      sendData(res, { ...run, actions });
    })
  );

  return router;
}
