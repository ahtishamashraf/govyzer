import { Router } from 'express';
import { z } from 'zod';
import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError } from '@govyzer/domain';
import { displaySchema, displayClaimSchema, playlistSchema, salesEventApprovalSchema, pointsRuleSchema, targetSchema, announcementSchema, idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, authenticateDisplay, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import { rateLimit } from '../../core/rate-limit.js';
import { sha256 } from '../../core/crypto.js';
import * as service from './service.js';

/** CRM-side Sales Screen management. Requires ordinary employee authentication. */
export function salesScreenRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/displays',
    requirePermission('sales_screen.read'),
    handler(async (req, res) => {
      const db = getDb();
      const displays = await db('sales_displays').where('organization_id', req.actor.organizationId).whereNull('deleted_at').orderBy('name');
      const onlineThreshold = new Date(Date.now() - 2 * 60 * 1000);
      sendData(
        res,
        displays.map((display) => ({
          ...display,
          privacy_settings: typeof display.privacy_settings === 'string' ? JSON.parse(display.privacy_settings ?? '{}') : display.privacy_settings,
          filters: typeof display.filters === 'string' ? JSON.parse(display.filters ?? 'null') : display.filters,
          is_online: Boolean(display.last_seen_at && new Date(display.last_seen_at) > onlineThreshold),
        }))
      );
    })
  );

  router.post(
    '/displays',
    requirePermission('sales_screen.manage'),
    validate({ body: displaySchema }),
    handler(async (req, res) => {
      sendData(res, await service.createDisplay({ organizationId: req.actor.organizationId, actor: req.actor, payload: req.validatedBody }), { status: 201 });
    })
  );

  router.patch(
    '/displays/:id',
    requirePermission('sales_screen.manage'),
    validate({ params: z.object({ id: idSchema }), body: displaySchema.partial() }),
    handler(async (req, res) => {
      const db = getDb();
      const payload = { ...req.validatedBody, updated_by: req.actor.membershipId, updated_at: db.fn.now() };
      if (payload.privacy_settings) payload.privacy_settings = JSON.stringify(payload.privacy_settings);
      if (payload.filters) payload.filters = JSON.stringify(payload.filters);
      if (payload.theme_overrides) payload.theme_overrides = JSON.stringify(payload.theme_overrides);
      const updated = await db('sales_displays').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).update(payload);
      if (updated === 0) throw new NotFoundError('Display');
      await service.bumpFeedVersion({ organizationId: req.actor.organizationId });
      sendData(res, await db('sales_displays').where('id', req.validatedParams.id).first());
    })
  );

  router.post(
    '/displays/:id/pairing-code',
    requirePermission('sales_screen.manage'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.issuePairingCode({ organizationId: req.actor.organizationId, actor: req.actor, displayId: req.validatedParams.id }), { status: 201 });
    })
  );

  router.post(
    '/displays/:id/revoke',
    requirePermission('sales_screen.manage'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ reason: z.string().max(200).optional() }) }),
    handler(async (req, res) => {
      sendData(res, await service.revokeDisplay({ organizationId: req.actor.organizationId, actor: req.actor, displayId: req.validatedParams.id, reason: req.validatedBody.reason }));
    })
  );

  router.get(
    '/displays/:id/preview',
    requirePermission('sales_screen.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.buildDisplayFeed({ organizationId: req.actor.organizationId, displayId: req.validatedParams.id }));
    })
  );

  // ---------- Playlists ----------
  router.get(
    '/playlists',
    requirePermission('sales_screen.read'),
    handler(async (req, res) => {
      const db = getDb();
      const playlists = await db('display_playlists').where('organization_id', req.actor.organizationId).whereNull('deleted_at').orderBy('name');
      const slides = playlists.length
        ? await db('display_slides').where('organization_id', req.actor.organizationId).whereIn('playlist_id', playlists.map((playlist) => playlist.id)).orderBy('position')
        : [];
      sendData(res, playlists.map((playlist) => ({ ...playlist, slides: slides.filter((slide) => slide.playlist_id === playlist.id) })));
    })
  );

  router.post(
    '/playlists',
    requirePermission('sales_screen.manage'),
    validate({ body: playlistSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { slides, ...playlist } = req.validatedBody;
      const id = newId();
      await withTransaction(db, async (trx) => {
        if (playlist.is_default) await trx('display_playlists').where('organization_id', req.actor.organizationId).update({ is_default: false });
        await trx('display_playlists').insert({ id, organization_id: req.actor.organizationId, ...playlist, created_by: req.actor.membershipId });
        if (slides.length > 0) {
          await trx('display_slides').insert(
            slides.map((slide) => ({
              id: newId(),
              organization_id: req.actor.organizationId,
              playlist_id: id,
              ...slide,
              config: JSON.stringify(slide.config ?? {}),
              filters: slide.filters ? JSON.stringify(slide.filters) : null,
            }))
          );
        }
      });
      sendData(res, await db('display_playlists').where('id', id).first(), { status: 201 });
    })
  );

  router.put(
    '/playlists/:id/slides',
    requirePermission('sales_screen.manage'),
    validate({ params: z.object({ id: idSchema }), body: playlistSchema.pick({ slides: true }) }),
    handler(async (req, res) => {
      const db = getDb();
      const playlist = await db('display_playlists').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!playlist) throw new NotFoundError('Playlist');
      await withTransaction(db, async (trx) => {
        await trx('display_slides').where({ organization_id: req.actor.organizationId, playlist_id: playlist.id }).delete();
        if (req.validatedBody.slides.length > 0) {
          await trx('display_slides').insert(
            req.validatedBody.slides.map((slide) => ({
              id: newId(),
              organization_id: req.actor.organizationId,
              playlist_id: playlist.id,
              ...slide,
              config: JSON.stringify(slide.config ?? {}),
              filters: slide.filters ? JSON.stringify(slide.filters) : null,
            }))
          );
        }
      });
      await service.bumpFeedVersion({ organizationId: req.actor.organizationId });
      sendData(res, await db('display_slides').where({ playlist_id: playlist.id }).orderBy('position'));
    })
  );

  // ---------- Events, points, targets, announcements ----------
  router.get(
    '/events',
    requirePermission('sales_screen.read'),
    validate({ query: paginationSchema.extend({ status: z.string().max(24).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('sales_events').where('organization_id', req.actor.organizationId);
      if (req.validatedQuery.status) query = query.where('status', req.validatedQuery.status);
      const rows = await query.orderBy('occurred_at', 'desc').limit(req.validatedQuery.per_page);
      sendList(
        res,
        rows.map((row) => ({ ...row, display_payload: typeof row.display_payload === 'string' ? JSON.parse(row.display_payload) : row.display_payload })),
        { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length }
      );
    })
  );

  router.post(
    '/events/:id/approval',
    requirePermission('sales_screen.approve_events'),
    validate({ params: z.object({ id: idSchema }), body: salesEventApprovalSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.approveSalesEvent({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          eventId: req.validatedParams.id,
          decision: req.validatedBody.decision,
          reason: req.validatedBody.reason,
        })
      );
    })
  );

  router.get(
    '/points/rules',
    requirePermission('sales_screen.read'),
    handler(async (req, res) => {
      const rows = await getDb()('points_rules').where('organization_id', req.actor.organizationId).whereNull('deleted_at').orderBy('code');
      sendData(res, rows);
    })
  );

  router.post(
    '/points/rules',
    requirePermission('sales_screen.points'),
    validate({ body: pointsRuleSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('points_rules').insert({
        id,
        organization_id: req.actor.organizationId,
        ...req.validatedBody,
        conditions: req.validatedBody.conditions ? JSON.stringify(req.validatedBody.conditions) : null,
        version_number: 1,
        created_by: req.actor.membershipId,
      });
      sendData(res, await db('points_rules').where('id', id).first(), { status: 201 });
    })
  );

  router.patch(
    '/points/rules/:id',
    requirePermission('sales_screen.points'),
    validate({ params: z.object({ id: idSchema }), body: pointsRuleSchema.partial() }),
    handler(async (req, res) => {
      const db = getDb();
      const rule = await db('points_rules').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!rule) throw new NotFoundError('Points rule');
      const payload = { ...req.validatedBody, version_number: Number(rule.version_number ?? 1) + 1, updated_at: db.fn.now() };
      if (payload.conditions) payload.conditions = JSON.stringify(payload.conditions);
      await db('points_rules').where('id', rule.id).update(payload);
      sendData(res, await db('points_rules').where('id', rule.id).first());
    })
  );

  router.get(
    '/points/leaderboard',
    requirePermission('sales_screen.read'),
    validate({ query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), group_by: z.enum(['membership_id', 'team_id', 'branch_id']).default('membership_id'), limit: z.coerce.number().int().min(1).max(50).default(10) }) }),
    handler(async (req, res) => {
      const db = getDb();
      const { buildLeaderboard } = await import('@govyzer/domain');
      let query = db('points_ledger').where('organization_id', req.actor.organizationId);
      if (req.validatedQuery.from) query = query.where('occurred_at', '>=', req.validatedQuery.from);
      if (req.validatedQuery.to) query = query.where('occurred_at', '<=', req.validatedQuery.to);
      const rows = await query.select('membership_id', 'team_id', 'branch_id', 'points');
      sendData(res, buildLeaderboard(rows, { groupBy: req.validatedQuery.group_by, limit: req.validatedQuery.limit }));
    })
  );

  router.get(
    '/targets',
    requirePermission('sales_screen.read'),
    handler(async (req, res) => {
      const rows = await getDb()('targets').where('organization_id', req.actor.organizationId).whereNull('deleted_at').orderBy('period_start', 'desc');
      sendData(res, rows);
    })
  );

  router.post(
    '/targets',
    requirePermission('sales_screen.points'),
    validate({ body: targetSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('targets').insert({ id, organization_id: req.actor.organizationId, ...req.validatedBody, created_by: req.actor.membershipId });
      sendData(res, await db('targets').where('id', id).first(), { status: 201 });
    })
  );

  router.post(
    '/announcements',
    requirePermission('sales_screen.announce'),
    validate({ body: announcementSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('announcements').insert({
        id,
        organization_id: req.actor.organizationId,
        ...req.validatedBody,
        display_ids: req.validatedBody.display_ids ? JSON.stringify(req.validatedBody.display_ids) : null,
        created_by: req.actor.membershipId,
      });
      await service.bumpFeedVersion({ organizationId: req.actor.organizationId });
      sendData(res, await db('announcements').where('id', id).first(), { status: 201 });
    })
  );

  return router;
}

/** Display-scoped API. These routes never expose CRM data beyond the approved feed. */
export function displayRoutes() {
  const router = Router();

  router.post(
    '/pair',
    rateLimit({ name: 'display-pair', max: 10, windowMs: 60_000, keyResolver: (req) => req.ip }),
    validate({ body: displayClaimSchema }),
    handler(async (req, res) => {
      const result = await service.claimPairingCode({
        code: req.validatedBody.code.toUpperCase(),
        deviceFingerprint: req.validatedBody.device_fingerprint ?? null,
        appVersion: req.validatedBody.app_version ?? null,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      sendData(res, result, { status: 201 });
    })
  );

  router.use(authenticateDisplay());

  router.get(
    '/feed',
    rateLimit({ name: 'display-feed', max: 600, windowMs: 60_000, keyResolver: (req) => req.display?.id ?? req.ip }),
    handler(async (req, res) => {
      const feed = await service.buildDisplayFeed({ organizationId: req.actor.organizationId, displayId: req.display.id });
      const etag = `W/"${sha256(JSON.stringify({ v: feed.display.feed_version, e: feed.events.map((event) => event.id), m: feed.metrics })).slice(0, 32)}"`;
      res.setHeader('etag', etag);
      res.setHeader('cache-control', 'no-store');
      if (req.get('if-none-match') === etag) return res.status(304).end();
      sendData(res, feed);
    })
  );

  router.post(
    '/heartbeat',
    validate({ body: z.object({ app_version: z.string().max(40).optional() }) }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.heartbeat({
          organizationId: req.actor.organizationId,
          displayId: req.display.id,
          sessionId: req.displaySession.id,
          appVersion: req.validatedBody.app_version ?? null,
        })
      );
    })
  );

  return router;
}
