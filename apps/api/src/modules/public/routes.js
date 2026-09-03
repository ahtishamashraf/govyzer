import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { inboundLeadSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData } from '../../core/responses.js';
import { rateLimit } from '../../core/rate-limit.js';
import { buildFeed } from '../portals/service.js';
import { ingestNormalizedLead } from '../webhooks/service.js';
import { EVENT_TYPES } from '../../core/outbox.js';

/** Tenant-facing public surface: portal feeds and the Zapier-ready lead intake API. */
export function publicRoutes() {
  const router = Router();

  router.get(
    '/feeds/:provider/:token.:format(xml|json)',
    rateLimit({ name: 'feeds', max: 120, windowMs: 60_000, keyResolver: (req) => `${req.ip}:${req.params.provider}` }),
    validate({ params: z.object({ provider: z.string().max(40), token: z.string().min(10).max(120), format: z.enum(['xml', 'json']) }) }),
    handler(async (req, res) => {
      const feed = await buildFeed({
        providerCode: req.validatedParams.provider,
        feedToken: req.validatedParams.token,
        format: req.validatedParams.format,
      });
      res.setHeader('content-type', typeof feed.body === 'string' ? 'application/xml; charset=utf-8' : 'application/json');
      res.setHeader('x-listing-count', String(feed.count));
      return typeof feed.body === 'string' ? res.send(feed.body) : res.json(feed.body);
    })
  );

  // Zapier "Add Lead" action and any website form post. Authorized by a tenant API key.
  router.post(
    '/leads',
    rateLimit({ name: 'public-leads', max: 240, windowMs: 60_000, keyResolver: (req) => req.get('x-api-key') ?? req.ip }),
    authenticate(),
    requireAuth(),
    validate({ body: inboundLeadSchema }),
    handler(async (req, res) => {
      if (req.actor.type !== 'api_key') {
        const { ForbiddenError } = await import('@govyzer/domain');
        throw new ForbiddenError('This endpoint requires a tenant API key');
      }
      const scopes = req.actor.permissions;
      if (!scopes.has('leads.create') && !scopes.has('*')) {
        const { ForbiddenError } = await import('@govyzer/domain');
        throw new ForbiddenError('This API key does not have the leads.create scope');
      }

      const payload = req.validatedBody;
      const normalized = {
        provider: payload.source ?? 'api',
        external_id: payload.external_id ?? null,
        name: payload.name ?? ([payload.first_name, payload.last_name].filter(Boolean).join(' ') || null),
        email: payload.email ?? null,
        phone: payload.phone ?? null,
        message: payload.message ?? null,
        property_reference: payload.property_reference ?? payload.listing_reference ?? null,
        source: payload.source ?? 'api',
        portal_code: payload.portal_code ?? null,
        module: payload.module ?? 'ready',
        purpose: payload.purpose ?? 'buy',
        budget_min: payload.budget_min ?? null,
        budget_max: payload.budget_max ?? null,
        bedrooms: payload.bedrooms ?? null,
        language: payload.language ?? 'en',
        utm: payload.utm ?? null,
        raw: payload.raw ?? payload,
      };

      const result = await ingestNormalizedLead({
        organizationId: req.actor.organizationId,
        normalized,
        provider: payload.source ?? 'api',
      });
      sendData(res, result, { status: result.duplicate ? 200 : 201 });
    })
  );

  router.get(
    '/zapier/triggers',
    authenticate(),
    requireAuth(),
    handler(async (req, res) => {
      sendData(res, {
        triggers: [
          { key: 'new_lead', event: EVENT_TYPES.LEAD_CREATED, description: 'Fires when a lead is created from any source' },
          { key: 'lead_updated', event: EVENT_TYPES.LEAD_UPDATED, description: 'Fires when a lead changes' },
          { key: 'new_listing', event: EVENT_TYPES.LISTING_CREATED, description: 'Fires when a listing is created' },
          { key: 'listing_published', event: EVENT_TYPES.LISTING_PUBLISHED, description: 'Fires when a listing goes live on a portal' },
          { key: 'meeting_created', event: EVENT_TYPES.MEETING_CREATED, description: 'Fires when a meeting or viewing is scheduled' },
          { key: 'deal_won', event: EVENT_TYPES.DEAL_WON, description: 'Fires when a deal is won' },
          { key: 'deal_updated', event: EVENT_TYPES.DEAL_UPDATED, description: 'Fires when a deal changes' },
        ],
        actions: [{ key: 'add_lead', method: 'POST', path: '/v1/public/leads', description: 'Create a lead from any external system' }],
        authentication: { type: 'api_key', header: 'x-api-key', scopes_required: ['leads.create'] },
      });
    })
  );

  router.get(
    '/zapier/sample/:trigger',
    authenticate(),
    requireAuth(),
    handler(async (req, res) => {
      const db = getDb();
      const samples = {
        new_lead: await db('leads').where('organization_id', req.actor.organizationId).orderBy('created_at', 'desc').first(),
        new_listing: await db('listings').where('organization_id', req.actor.organizationId).orderBy('created_at', 'desc').first(),
        deal_won: await db('deals').where({ organization_id: req.actor.organizationId, status: 'won' }).orderBy('won_at', 'desc').first(),
      };
      sendData(res, samples[req.params.trigger] ?? null);
    })
  );

  return router;
}
