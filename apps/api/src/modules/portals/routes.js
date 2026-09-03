import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { portalAccountSchema, idSchema, paginationSchema } from '@govyzer/validation';
import { NotFoundError } from '@govyzer/domain';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import * as service from './service.js';

export function portalRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/providers',
    requirePermission('portals.read'),
    handler(async (req, res) => sendData(res, await service.listProviders()))
  );

  router.get(
    '/accounts',
    requirePermission('portals.read'),
    handler(async (req, res) => {
      const rows = await getDb()('portal_accounts')
        .where('organization_id', req.actor.organizationId)
        .whereNull('deleted_at')
        .orderBy('name')
        .select('id', 'provider_code', 'name', 'status', 'health_status', 'health_message', 'auto_publish', 'is_enabled', 'listing_quota', 'listing_used', 'last_checked_at', 'last_success_at', 'created_at');
      sendData(res, rows);
    })
  );

  router.post(
    '/accounts',
    requirePermission('portals.manage'),
    validate({ body: portalAccountSchema }),
    handler(async (req, res) => {
      const result = await service.connectPortalAccount({
        organizationId: req.actor.organizationId,
        actor: req.actor,
        payload: req.validatedBody,
      });
      sendData(res, { account: { ...result.account, feed_token: undefined }, health: result.health }, { status: 201 });
    })
  );

  router.post(
    '/accounts/:id/test',
    requirePermission('portals.manage'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.testPortalAccount({ organizationId: req.actor.organizationId, accountId: req.validatedParams.id }));
    })
  );

  router.get(
    '/accounts/:id/feed-url',
    requirePermission('portals.manage'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const account = await getDb()('portal_accounts').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!account) throw new NotFoundError('Portal account');
      const { loadServerConfig } = await import('@govyzer/config');
      const { env } = loadServerConfig();
      sendData(res, {
        feed_url: `${env.API_PUBLIC_URL}/v1/public/feeds/${account.provider_code}/${account.feed_token}.xml`,
        json_feed_url: `${env.API_PUBLIC_URL}/v1/public/feeds/${account.provider_code}/${account.feed_token}.json`,
        instructions: 'Give this URL to the portal so it can pull your listings. Rotate it by reconnecting the account.',
      });
    })
  );

  router.get(
    '/accounts/:id/mappings',
    requirePermission('portals.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const rows = await getDb()('portal_field_mappings')
        .where({ organization_id: req.actor.organizationId, portal_account_id: req.validatedParams.id })
        .orderBy(['mapping_type', 'internal_value']);
      sendData(res, rows);
    })
  );

  router.put(
    '/accounts/:id/mappings',
    requirePermission('portals.manage'),
    validate({
      params: z.object({ id: idSchema }),
      body: z.object({
        mappings: z
          .array(
            z.object({
              mapping_type: z.string().min(1).max(40),
              internal_value: z.string().min(1).max(190),
              provider_value: z.string().min(1).max(190),
            })
          )
          .max(1000),
      }),
    }),
    handler(async (req, res) => {
      const db = getDb();
      const { newId } = await import('@govyzer/domain');
      const account = await db('portal_accounts').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!account) throw new NotFoundError('Portal account');

      await db('portal_field_mappings').where({ organization_id: req.actor.organizationId, portal_account_id: account.id }).delete();
      if (req.validatedBody.mappings.length > 0) {
        await db('portal_field_mappings').insert(
          req.validatedBody.mappings.map((mapping) => ({
            id: newId(),
            organization_id: req.actor.organizationId,
            portal_account_id: account.id,
            ...mapping,
          }))
        );
      }
      sendData(res, { saved: req.validatedBody.mappings.length });
    })
  );

  router.get(
    '/publications',
    requirePermission('portals.read'),
    validate({ query: paginationSchema.extend({ status: z.string().max(30).optional(), provider_code: z.string().max(40).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      const build = () => {
        let builder = db('portal_publications as p')
          .join('listings as l', 'l.id', 'p.listing_id')
          .where('p.organization_id', req.actor.organizationId)
          .whereNull('p.deleted_at');
        if (query.status) builder = builder.where('p.status', query.status);
        if (query.provider_code) builder = builder.where('p.provider_code', query.provider_code);
        return builder;
      };
      const [{ total }] = await build().clearOrder().count({ total: 'p.id' });
      const rows = await build()
        .select('p.*', 'l.reference as listing_reference', 'l.title as listing_title')
        .orderBy('p.updated_at', 'desc')
        .limit(query.per_page)
        .offset((query.page - 1) * query.per_page);
      sendList(
        res,
        rows.map((row) => ({ ...row, validation_errors: typeof row.validation_errors === 'string' ? JSON.parse(row.validation_errors ?? '[]') : row.validation_errors })),
        { page: query.page, perPage: query.per_page, total: Number(total) }
      );
    })
  );

  router.get(
    '/errors',
    requirePermission('portals.read'),
    validate({ query: paginationSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const rows = await db('portal_publications as p')
        .join('listings as l', 'l.id', 'p.listing_id')
        .join('portal_accounts as a', 'a.id', 'p.portal_account_id')
        .where('p.organization_id', req.actor.organizationId)
        .whereIn('p.status', ['failed', 'rejected'])
        .orderBy('p.updated_at', 'desc')
        .limit(req.validatedQuery.per_page)
        .select('p.id', 'p.status', 'p.last_error_code', 'p.last_error_message', 'p.validation_errors', 'p.attempts', 'p.updated_at', 'l.id as listing_id', 'l.reference', 'l.title', 'a.name as account_name', 'a.provider_code');
      sendData(
        res,
        rows.map((row) => ({
          ...row,
          validation_errors: typeof row.validation_errors === 'string' ? JSON.parse(row.validation_errors ?? '[]') : row.validation_errors,
        }))
      );
    })
  );

  router.post(
    '/publications/:id/retry',
    requirePermission('listings.publish'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const publication = await db('portal_publications').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!publication) throw new NotFoundError('Publication');
      await db('portal_publications').where('id', publication.id).update({ status: 'queued', updated_at: db.fn.now() });
      const { enqueueJob } = await import('../../core/jobs.js');
      const { JOB_TYPES } = await import('../../jobs/index.js');
      await enqueueJob({
        organizationId: req.actor.organizationId,
        jobType: JOB_TYPES.PORTAL_PUBLISH,
        payload: { publication_id: publication.id },
        dedupeKey: `portal-publish-retry:${publication.id}:${Date.now()}`,
      });
      sendData(res, { queued: true });
    })
  );

  router.get(
    '/logs',
    requirePermission('portals.read'),
    validate({ query: paginationSchema.extend({ portal_account_id: idSchema.optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('portal_sync_logs').where('organization_id', req.actor.organizationId);
      if (req.validatedQuery.portal_account_id) query = query.where('portal_account_id', req.validatedQuery.portal_account_id);
      const rows = await query.orderBy('created_at', 'desc').limit(req.validatedQuery.per_page);
      sendData(res, rows);
    })
  );

  return router;
}
