import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { aiRequestSchema, aiFeedbackSchema, idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import { rateLimit } from '../../core/rate-limit.js';
import { isAiEnabled } from './provider.js';
import * as service from './service.js';

export function aiRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/status',
    handler(async (req, res) =>
      sendData(res, {
        enabled: isAiEnabled(),
        features: ['lead_scoring', 'lead_matching', 'conversation_summary', 'reply_suggestion', 'listing_copy', 'price_intelligence', 'duplicate_detection', 'natural_language_report', 'meeting_summary', 'data_quality'],
        note: isAiEnabled() ? null : 'AI is unavailable on this deployment. Every CRM feature keeps working without it.',
      })
    )
  );

  router.post(
    '/run',
    requirePermission('ai.use'),
    rateLimit({ name: 'ai', max: 60, windowMs: 60_000 }),
    validate({ body: aiRequestSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.runAiFeature({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          feature: req.validatedBody.feature,
          entityType: req.validatedBody.entity_type ?? null,
          entityId: req.validatedBody.entity_id ?? null,
          input: req.validatedBody.input,
          language: req.validatedBody.language,
          requestId: req.requestId,
        })
      );
    })
  );

  router.post(
    '/artifacts/:id/apply',
    requirePermission('ai.use'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => sendData(res, await service.applyArtifact({ organizationId: req.actor.organizationId, actor: req.actor, artifactId: req.validatedParams.id })))
  );

  router.post(
    '/feedback',
    requirePermission('ai.use'),
    validate({ body: aiFeedbackSchema }),
    handler(async (req, res) => sendData(res, await service.recordFeedback({ organizationId: req.actor.organizationId, actor: req.actor, payload: req.validatedBody }), { status: 201 }))
  );

  router.get(
    '/usage',
    requirePermission('ai.manage'),
    validate({ query: paginationSchema }),
    handler(async (req, res) => {
      const rows = await getDb()('ai_usage_ledger').where('organization_id', req.actor.organizationId).orderBy('period', 'desc').limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  return router;
}
