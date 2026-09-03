import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { listingSchema, listingStatusSchema, listingApprovalSchema, listingSearchSchema, publishListingSchema, idSchema } from '@govyzer/validation';
import { NotFoundError } from '@govyzer/domain';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { applyRecordScope } from '../../core/repository.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList, sendNoContent } from '../../core/responses.js';
import { idempotency } from '../../core/idempotency.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';
import * as service from './service.js';
import * as portalService from '../portals/service.js';

export function listingRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/',
    requirePermission('listings.read'),
    validate({ query: listingSearchSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      const build = () => {
        let builder = db('listings').where('listings.organization_id', req.actor.organizationId).whereNull('listings.deleted_at');
        builder = applyRecordScope(builder, req.actor, { table: 'listings', assignedColumn: 'primary_agent_membership_id' });
        if (query.status) {
          builder = Array.isArray(query.status) ? builder.whereIn('listings.status', query.status) : builder.where('listings.status', query.status);
        }
        if (query.offering_type) builder = builder.where('listings.offering_type', query.offering_type);
        if (query.property_type) builder = builder.where('listings.property_type', query.property_type);
        if (query.community_id) builder = builder.where('listings.community_id', query.community_id);
        if (query.agent_membership_id) builder = builder.where('listings.primary_agent_membership_id', query.agent_membership_id);
        if (query.price_min) builder = builder.where('listings.price', '>=', query.price_min);
        if (query.price_max) builder = builder.where('listings.price', '<=', query.price_max);
        if (query.bedrooms != null) builder = builder.where('listings.bedrooms', query.bedrooms);
        if (query.permit_expiring_days != null) {
          const limit = new Date(Date.now() + query.permit_expiring_days * 24 * 60 * 60 * 1000);
          builder = builder.whereNotNull('listings.permit_expires_on').where('listings.permit_expires_on', '<=', limit);
        }
        if (query.portal_status) {
          builder = builder.whereIn('listings.id', function subquery() {
            this.select('listing_id').from('portal_publications').where('organization_id', req.actor.organizationId).where('status', query.portal_status);
          });
        }
        if (query.q) {
          builder = builder.where((inner) =>
            inner
              .where('listings.title', 'like', `%${query.q}%`)
              .orWhere('listings.reference', 'like', `%${query.q}%`)
              .orWhere('listings.permit_number', 'like', `%${query.q}%`)
          );
        }
        return builder;
      };

      const [{ total }] = await build().clearOrder().count({ total: 'listings.id' });
      const rows = await build()
        .orderBy(`listings.${query.sort ?? 'updated_at'}`, query.direction)
        .limit(query.per_page)
        .offset((query.page - 1) * query.per_page);
      sendList(res, rows, { page: query.page, perPage: query.per_page, total: Number(total) });
    })
  );

  router.post(
    '/',
    requirePermission('listings.create'),
    idempotency('listings.create'),
    validate({ body: listingSchema }),
    handler(async (req, res) => {
      const result = await service.createListing({
        organizationId: req.actor.organizationId,
        actor: req.actor,
        payload: req.validatedBody,
        request: { requestId: req.requestId },
      });
      sendData(res, result, { status: 201 });
    })
  );

  router.get(
    '/:id',
    requirePermission('listings.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.getListing({ organizationId: req.actor.organizationId, id: req.validatedParams.id }));
    })
  );

  router.patch(
    '/:id',
    requirePermission('listings.update'),
    validate({ params: z.object({ id: idSchema }), body: listingSchema.partial() }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.updateListing({
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
    '/:id/submit',
    requirePermission('listings.update'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.submitForApproval({ organizationId: req.actor.organizationId, actor: req.actor, id: req.validatedParams.id }));
    })
  );

  router.post(
    '/:id/approval',
    requirePermission('listings.approve'),
    validate({ params: z.object({ id: idSchema }), body: listingApprovalSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.decideApproval({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          id: req.validatedParams.id,
          decision: req.validatedBody.decision,
          reason: req.validatedBody.reason,
          checklist: req.validatedBody.checklist,
        })
      );
    })
  );

  router.post(
    '/:id/status',
    requirePermission('listings.update'),
    validate({ params: z.object({ id: idSchema }), body: listingStatusSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.changeStatus({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          id: req.validatedParams.id,
          status: req.validatedBody.status,
          reason: req.validatedBody.reason,
        })
      );
    })
  );

  router.post(
    '/:id/validate',
    requirePermission('listings.publish'),
    validate({ params: z.object({ id: idSchema }), body: publishListingSchema.partial({ portal_account_ids: true }) }),
    handler(async (req, res) => {
      const db = getDb();
      const accountIds =
        req.validatedBody.portal_account_ids ??
        (await db('portal_accounts').where({ organization_id: req.actor.organizationId, is_enabled: true }).whereNull('deleted_at').pluck('id'));
      sendData(res, await portalService.validateForPortals({ organizationId: req.actor.organizationId, listingId: req.validatedParams.id, portalAccountIds: accountIds }));
    })
  );

  router.post(
    '/:id/publish',
    requirePermission('listings.publish'),
    idempotency('listings.publish'),
    validate({ params: z.object({ id: idSchema }), body: publishListingSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await portalService.publishListing({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          listingId: req.validatedParams.id,
          portalAccountIds: req.validatedBody.portal_account_ids,
          validateOnly: req.validatedBody.validate_only,
        })
      );
    })
  );

  router.post(
    '/:id/unpublish',
    requirePermission('listings.publish'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ portal_account_ids: z.array(idSchema).optional() }) }),
    handler(async (req, res) => {
      sendData(
        res,
        await portalService.unpublishListing({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          listingId: req.validatedParams.id,
          portalAccountIds: req.validatedBody.portal_account_ids ?? null,
        })
      );
    })
  );

  router.get(
    '/:id/publications',
    requirePermission('portals.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const rows = await db('portal_publications as p')
        .leftJoin('portal_accounts as a', 'a.id', 'p.portal_account_id')
        .where('p.organization_id', req.actor.organizationId)
        .where('p.listing_id', req.validatedParams.id)
        .select('p.*', 'a.name as account_name', 'a.health_status');
      sendData(
        res,
        rows.map((row) => ({
          ...row,
          validation_errors: typeof row.validation_errors === 'string' ? JSON.parse(row.validation_errors ?? '[]') : row.validation_errors,
        }))
      );
    })
  );

  router.get(
    '/:id/versions',
    requirePermission('listings.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const rows = await db('listing_versions')
        .where({ organization_id: req.actor.organizationId, listing_id: req.validatedParams.id })
        .orderBy('version_number', 'desc')
        .limit(50);
      sendData(res, rows);
    })
  );

  router.get(
    '/:id/canonical',
    requirePermission('listings.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const { canonical } = await service.buildCanonical({ organizationId: req.actor.organizationId, listingId: req.validatedParams.id });
      sendData(res, canonical);
    })
  );

  router.delete(
    '/:id',
    requirePermission('listings.delete'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const before = await db('listings').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!before) throw new NotFoundError('Listing');
      await db('listings').where('id', before.id).update({ deleted_at: db.fn.now(), updated_by: req.actor.membershipId });
      await recordAudit({ ...auditFromRequest(req), action: 'listing.deleted', entityType: 'listing', entityId: before.id, before });
      sendNoContent(res);
    })
  );

  return router;
}
