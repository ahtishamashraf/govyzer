import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import {
  leadCreateSchema,
  leadUpdateSchema,
  leadStageChangeSchema,
  leadAssignSchema,
  leadPoolReleaseSchema,
  leadSearchSchema,
  idSchema,
} from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { applyRecordScope } from '../../core/repository.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList, sendNoContent } from '../../core/responses.js';
import { idempotency } from '../../core/idempotency.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';
import * as service from './service.js';

export function leadRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/',
    requirePermission('leads.read'),
    validate({ query: leadSearchSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      const build = () => {
        let builder = db('leads')
          .where('leads.organization_id', req.actor.organizationId)
          .whereNull('leads.deleted_at');
        builder = applyRecordScope(builder, req.actor, { table: 'leads', assignedColumn: 'assigned_membership_id' });
        if (query.module) builder = builder.where('leads.module', query.module);
        if (query.stage_code) builder = builder.where('leads.stage_code', query.stage_code);
        if (query.status) builder = builder.where('leads.status', query.status);
        if (query.assigned_membership_id) builder = builder.where('leads.assigned_membership_id', query.assigned_membership_id);
        if (query.source_id) builder = builder.where('leads.source_id', query.source_id);
        if (query.campaign_id) builder = builder.where('leads.campaign_id', query.campaign_id);
        if (query.project_id) builder = builder.where('leads.project_id', query.project_id);
        if (query.listing_id) builder = builder.where('leads.listing_id', query.listing_id);
        if (query.in_pool != null) builder = builder.where('leads.is_in_pool', query.in_pool);
        if (query.created_from) builder = builder.where('leads.created_at', '>=', query.created_from);
        if (query.created_to) builder = builder.where('leads.created_at', '<=', query.created_to);
        if (query.q) {
          builder = builder
            .leftJoin('contacts', 'contacts.id', 'leads.contact_id')
            .where((inner) =>
              inner
                .where('leads.reference', 'like', `%${query.q}%`)
                .orWhere('contacts.display_name', 'like', `%${query.q}%`)
                .orWhere('leads.property_reference', 'like', `%${query.q}%`)
            );
        }
        return builder;
      };

      const [{ total }] = await build().clearOrder().countDistinct({ total: 'leads.id' });
      const rows = await build()
        .distinct('leads.*')
        .orderBy(`leads.${query.sort ?? 'created_at'}`, query.direction)
        .limit(query.per_page)
        .offset((query.page - 1) * query.per_page);

      const contactIds = [...new Set(rows.map((row) => row.contact_id))];
      const contacts = contactIds.length
        ? await db('contacts').where('organization_id', req.actor.organizationId).whereIn('id', contactIds).select('id', 'display_name', 'reference')
        : [];
      const contactMap = new Map(contacts.map((contact) => [contact.id, contact]));

      sendList(
        res,
        rows.map((row) => ({ ...row, contact: contactMap.get(row.contact_id) ?? null })),
        { page: query.page, perPage: query.per_page, total: Number(total) }
      );
    })
  );

  router.get(
    '/pipeline',
    requirePermission('leads.read'),
    validate({ query: z.object({ module: z.enum(['ready', 'offplan']).default('ready') }) }),
    handler(async (req, res) => {
      const db = getDb();
      const organizationId = req.actor.organizationId;
      const stages = await service.loadStageDefinitions({ organizationId, pipeline: req.validatedQuery.module });
      let counts = db('leads')
        .where('organization_id', organizationId)
        .where('module', req.validatedQuery.module)
        .whereNull('deleted_at')
        .groupBy('stage_code')
        .select('stage_code')
        .count({ total: 'id' })
        .sum({ value: 'estimated_value' });
      counts = applyRecordScope(counts, req.actor, { table: 'leads', assignedColumn: 'assigned_membership_id' });
      const rows = await counts;
      const countMap = new Map(rows.map((row) => [row.stage_code, row]));
      sendData(
        res,
        stages.map((stage) => ({
          code: stage.code,
          name: stage.name,
          category: stage.category,
          position: stage.position,
          color: stage.color,
          lead_count: Number(countMap.get(stage.code)?.total ?? 0),
          estimated_value: Number(countMap.get(stage.code)?.value ?? 0),
        }))
      );
    })
  );

  router.get(
    '/pool',
    requirePermission('leads.read'),
    handler(async (req, res) => {
      const db = getDb();
      const rows = await db('lead_pool_entries as p')
        .join('leads as l', 'l.id', 'p.lead_id')
        .leftJoin('contacts as c', 'c.id', 'l.contact_id')
        .where('p.organization_id', req.actor.organizationId)
        .where('p.status', 'available')
        .whereNull('l.deleted_at')
        .orderBy('p.released_at', 'desc')
        .limit(100)
        .select('p.id as pool_entry_id', 'p.released_at', 'p.release_reason', 'p.expires_at', 'l.*', 'c.display_name as contact_name');
      sendData(res, rows);
    })
  );

  router.post(
    '/',
    requirePermission('leads.create'),
    idempotency('leads.create'),
    validate({ body: leadCreateSchema }),
    handler(async (req, res) => {
      const result = await service.createLead({
        organizationId: req.actor.organizationId,
        actor: req.actor,
        payload: req.validatedBody,
        source: 'manual',
        request: { requestId: req.requestId },
      });
      sendData(res, result, { status: 201 });
    })
  );

  router.get(
    '/:id',
    requirePermission('leads.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.getLead({ organizationId: req.actor.organizationId, id: req.validatedParams.id }));
    })
  );

  router.patch(
    '/:id',
    requirePermission('leads.update'),
    validate({ params: z.object({ id: idSchema }), body: leadUpdateSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.updateLead({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          id: req.validatedParams.id,
          payload: req.validatedBody,
          request: { requestId: req.requestId },
        })
      );
    })
  );

  router.post(
    '/:id/stage',
    requirePermission('leads.update'),
    validate({ params: z.object({ id: idSchema }), body: leadStageChangeSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.changeStage({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          id: req.validatedParams.id,
          stageCode: req.validatedBody.stage_code,
          reason: req.validatedBody.reason,
          lossReason: req.validatedBody.loss_reason,
        })
      );
    })
  );

  router.post(
    '/:id/acknowledge',
    requirePermission('leads.update'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.acknowledgeLead({ organizationId: req.actor.organizationId, id: req.validatedParams.id }));
    })
  );

  router.post(
    '/:id/assign',
    requirePermission('leads.assign'),
    validate({ params: z.object({ id: idSchema }), body: leadAssignSchema }),
    handler(async (req, res) => {
      const result = await service.assign({
        organizationId: req.actor.organizationId,
        actor: req.actor,
        id: req.validatedParams.id,
        membershipId: req.validatedBody.auto ? null : req.validatedBody.membership_id ?? null,
        reason: req.validatedBody.reason,
      });
      sendData(res, result);
    })
  );

  router.post(
    '/:id/release-to-pool',
    requirePermission('leads.pool_manage'),
    validate({ params: z.object({ id: idSchema }), body: leadPoolReleaseSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.releaseToPool({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          id: req.validatedParams.id,
          reason: req.validatedBody.reason,
          eligibleMembershipIds: req.validatedBody.eligible_membership_ids ?? null,
          expiresAt: req.validatedBody.expires_at ?? null,
        })
      );
    })
  );

  router.post(
    '/:id/claim',
    requirePermission('leads.claim'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.claimFromPool({ organizationId: req.actor.organizationId, actor: req.actor, id: req.validatedParams.id }));
    })
  );

  router.delete(
    '/:id',
    requirePermission('leads.delete'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const before = await db('leads').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!before) return sendNoContent(res);
      await db('leads').where('id', before.id).update({ deleted_at: db.fn.now(), updated_by: req.actor.membershipId });
      await recordAudit({ ...auditFromRequest(req), action: 'lead.deleted', entityType: 'lead', entityId: before.id, before });
      sendNoContent(res);
    })
  );

  return router;
}
