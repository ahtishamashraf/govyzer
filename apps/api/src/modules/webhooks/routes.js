import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { loadServerConfig } from '@govyzer/config';
import { getIntegrationAdapter } from '@govyzer/integrations';
import { validate } from '../../middleware/validate.js';
import { handler } from '../../core/async-handler.js';
import { sendData } from '../../core/responses.js';
import { rateLimit } from '../../core/rate-limit.js';
import { receiveWebhook } from './service.js';
import { loadConnectionCredentials } from './service.js';
import { logger } from '../../core/logger.js';

/**
 * Inbound webhooks. Each endpoint verifies the signature it can, stores the raw payload
 * and returns immediately; all normalization happens in the job queue.
 */
export function webhookRoutes() {
  const router = Router();
  const limiter = rateLimit({ name: 'webhooks', max: 600, windowMs: 60_000, keyResolver: (req) => `${req.ip}:${req.path}` });

  // WhatsApp Business Cloud verification handshake.
  router.get(
    '/whatsapp',
    handler(async (req, res) => {
      const { env } = loadServerConfig();
      if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_VERIFY_TOKEN) {
        return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
      }
      return res.status(403).send('verification failed');
    })
  );

  router.post(
    '/whatsapp',
    limiter,
    handler(async (req, res) => {
      const { env } = loadServerConfig();
      const adapter = getIntegrationAdapter('whatsapp_cloud');
      const verification = adapter.verifyWebhookSignature({
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        signature: req.get('x-hub-signature-256'),
        secret: env.WHATSAPP_APP_SECRET,
      });

      const organizationId = await resolveOrganizationForProvider('whatsapp_cloud', req);
      const result = await receiveWebhook({
        provider: 'whatsapp_cloud',
        headers: { 'x-hub-signature-256': verification.verified ? 'verified' : 'unverified' },
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        organizationId,
        externalEventId: req.body?.entry?.[0]?.id ?? null,
        signatureStatus: verification.verified ? 'verified' : verification.reason,
        requestId: req.requestId,
      });
      sendData(res, { received: true, ...result });
    })
  );

  router.post(
    '/whatsyncs',
    limiter,
    handler(async (req, res) => {
      const { env } = loadServerConfig();
      const adapter = getIntegrationAdapter('whatsyncs');
      const organizationId = await resolveOrganizationForProvider('whatsyncs', req);
      let secret = env.WHATSYNCS_WEBHOOK_SECRET;
      if (organizationId) {
        const db = getDb();
        const connection = await db('integration_connections').where({ organization_id: organizationId, provider: 'whatsyncs' }).first();
        if (connection) {
          const credentials = await loadConnectionCredentials({ connectionId: connection.id }).catch(() => ({}));
          secret = credentials.webhook_secret ?? secret;
        }
      }
      const verification = adapter.verifyWebhookSignature({
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        signature: req.get('x-whatsyncs-signature') ?? req.get('x-signature'),
        secret,
      });

      const result = await receiveWebhook({
        provider: 'whatsyncs',
        headers: { signature: verification.verified ? 'verified' : 'unverified' },
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        organizationId,
        externalEventId: req.body?.message?.id ?? req.body?.id ?? null,
        signatureStatus: verification.verified ? 'verified' : verification.reason,
        requestId: req.requestId,
      });
      sendData(res, { received: true, ...result });
    })
  );

  router.post(
    '/portal/:provider/:token',
    limiter,
    validate({ params: z.object({ provider: z.string().max(40), token: z.string().min(10).max(120) }) }),
    handler(async (req, res) => {
      const db = getDb();
      const account = await db('portal_accounts')
        .where({ provider_code: req.validatedParams.provider, feed_token: req.validatedParams.token })
        .whereNull('deleted_at')
        .first();
      if (!account) {
        logger.warn('portal_webhook_unknown_token', { provider: req.validatedParams.provider });
        return res.status(404).json({ error: { code: 'unknown_endpoint', message: 'Unknown portal webhook endpoint' } });
      }
      const result = await receiveWebhook({
        provider: req.validatedParams.provider,
        headers: {},
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        organizationId: account.organization_id,
        externalEventId: req.body?.lead_id ?? req.body?.id ?? null,
        signatureStatus: 'token_verified',
        requestId: req.requestId,
      });
      sendData(res, { received: true, ...result });
    })
  );

  router.post(
    '/signature/:provider',
    limiter,
    handler(async (req, res) => {
      const result = await receiveWebhook({
        provider: `${req.params.provider}_signature`,
        headers: {},
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        organizationId: '',
        externalEventId: req.body?.data?.envelopeId ?? null,
        requestId: req.requestId,
      });
      sendData(res, { received: true, ...result });
    })
  );

  return router;
}

/** Providers that cannot carry a tenant id map through their connected account. */
async function resolveOrganizationForProvider(provider, req) {
  const db = getDb();
  const explicit = req.get('x-organization-id');
  if (explicit) {
    const organization = await db('organizations').where('id', explicit).first('id');
    if (organization) return organization.id;
  }
  const connection = await db('integration_connections')
    .where({ provider, is_enabled: true })
    .whereNull('deleted_at')
    .orderBy('created_at')
    .first('organization_id');
  return connection?.organization_id ?? '';
}
