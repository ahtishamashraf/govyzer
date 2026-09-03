import { Router } from 'express';
import { z } from 'zod';
import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError, ValidationError } from '@govyzer/domain';
import { getIntegrationAdapter, listIntegrationAdapters } from '@govyzer/integrations';
import { integrationConnectionSchema, webhookEndpointSchema, apiKeySchema, idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import { encryptJson, encryptSecret, sha256, randomToken } from '../../core/crypto.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';
import { loadServerConfig } from '@govyzer/config';
import { loadConnectionCredentials } from '../webhooks/service.js';

export function integrationRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/providers',
    requirePermission('integrations.read'),
    handler(async (req, res) => sendData(res, listIntegrationAdapters()))
  );

  router.get(
    '/connections',
    requirePermission('integrations.read'),
    handler(async (req, res) => {
      const rows = await getDb()('integration_connections')
        .where('organization_id', req.actor.organizationId)
        .whereNull('deleted_at')
        .orderBy('provider')
        .select('id', 'provider', 'category', 'name', 'status', 'health_status', 'health_message', 'is_enabled', 'connected_at', 'last_checked_at', 'last_success_at', 'last_error_at', 'consecutive_failures', 'membership_id');
      sendData(res, rows);
    })
  );

  router.post(
    '/connections',
    requirePermission('integrations.manage'),
    validate({ body: integrationConnectionSchema }),
    handler(async (req, res) => {
      const adapter = getIntegrationAdapter(req.validatedBody.provider);
      if (!adapter) throw new ValidationError(`Unknown integration provider ${req.validatedBody.provider}`);

      const validation = adapter.validateConfiguration(req.validatedBody.credentials);
      if (!validation.valid) throw new ValidationError('The integration configuration is not valid', validation.errors);

      const db = getDb();
      const id = newId();
      await withTransaction(db, async (trx) => {
        await trx('integration_connections').insert({
          id,
          organization_id: req.actor.organizationId,
          provider: adapter.code,
          category: req.validatedBody.category,
          name: req.validatedBody.name,
          status: 'connecting',
          is_enabled: req.validatedBody.is_enabled,
          settings: JSON.stringify(req.validatedBody.settings),
          capabilities: JSON.stringify(adapter.getCapabilities()),
          membership_id: req.actor.membershipId,
          created_by: req.actor.membershipId,
        });
        const encrypted = encryptJson(validation.values);
        await trx('integration_credentials').insert({
          id: newId(),
          organization_id: req.actor.organizationId,
          connection_id: id,
          credential_type: 'api_key',
          key_version: encrypted.key_version,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          auth_tag: encrypted.auth_tag,
        });
      });

      const health = await adapter.testConnection({ credentials: validation.values });
      await db('integration_connections').where('id', id).update({
        status: health.ok ? 'connected' : 'error',
        health_status: health.ok ? 'healthy' : 'error',
        health_message: health.ok ? health.message ?? 'Connected' : JSON.stringify(health.errors ?? health.status ?? {}).slice(0, 500),
        connected_at: health.ok ? db.fn.now() : null,
        last_checked_at: db.fn.now(),
        last_success_at: health.ok ? db.fn.now() : null,
        external_account_id: health.identity ?? null,
      });

      await recordAudit({ ...auditFromRequest(req), action: 'integration.connected', entityType: 'integration_connection', entityId: id, after: { provider: adapter.code, health: health.status } });
      sendData(res, { connection: await db('integration_connections').where('id', id).first(), health }, { status: 201 });
    })
  );

  router.post(
    '/connections/:id/test',
    requirePermission('integrations.manage'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const connection = await db('integration_connections').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!connection) throw new NotFoundError('Connection');
      const adapter = getIntegrationAdapter(connection.provider);
      const credentials = await loadConnectionCredentials({ connectionId: connection.id });
      const health = await adapter.testConnection({ credentials });
      await db('integration_connections').where('id', connection.id).update({
        status: health.ok ? 'connected' : 'error',
        health_status: health.ok ? 'healthy' : 'error',
        health_message: health.ok ? health.message ?? 'Connected' : JSON.stringify(health.errors ?? {}).slice(0, 500),
        last_checked_at: db.fn.now(),
        last_success_at: health.ok ? db.fn.now() : connection.last_success_at,
        last_error_at: health.ok ? connection.last_error_at : db.fn.now(),
        consecutive_failures: health.ok ? 0 : Number(connection.consecutive_failures ?? 0) + 1,
      });
      sendData(res, health);
    })
  );

  router.get(
    '/health',
    requirePermission('integrations.read'),
    handler(async (req, res) => {
      const db = getDb();
      const [connections, portals, webhookFailures, deadLetters] = await Promise.all([
        db('integration_connections').where('organization_id', req.actor.organizationId).whereNull('deleted_at').select('provider', 'name', 'status', 'health_status', 'health_message', 'last_success_at'),
        db('portal_accounts').where('organization_id', req.actor.organizationId).whereNull('deleted_at').select('provider_code', 'name', 'status', 'health_status', 'health_message', 'last_success_at'),
        db('webhook_deliveries').where('organization_id', req.actor.organizationId).whereIn('status', ['pending', 'dead']).count({ total: 'id' }).first(),
        db('dead_letter_jobs').where('organization_id', req.actor.organizationId).where('status', 'open').count({ total: 'id' }).first(),
      ]);
      sendData(res, {
        connections,
        portals,
        pending_webhook_deliveries: Number(webhookFailures?.total ?? 0),
        open_dead_letter_jobs: Number(deadLetters?.total ?? 0),
        checked_at: new Date().toISOString(),
      });
    })
  );

  // ---------- OAuth ----------
  router.get(
    '/oauth/:provider/start',
    requirePermission('integrations.manage'),
    validate({ params: z.object({ provider: z.string().max(60) }) }),
    handler(async (req, res) => {
      const adapter = getIntegrationAdapter(req.validatedParams.provider);
      if (!adapter?.buildAuthorizeUrl) throw new ValidationError('This provider does not use OAuth');
      const { env } = loadServerConfig();
      const credentials = {
        client_id: req.validatedParams.provider.startsWith('google') || req.validatedParams.provider === 'gmail' ? env.GOOGLE_CLIENT_ID : env.MICROSOFT_CLIENT_ID,
        client_secret: req.validatedParams.provider.startsWith('google') || req.validatedParams.provider === 'gmail' ? env.GOOGLE_CLIENT_SECRET : env.MICROSOFT_CLIENT_SECRET,
        redirect_uri: `${env.API_PUBLIC_URL}/v1/integrations/oauth/${req.validatedParams.provider}/callback`,
      };
      if (!credentials.client_id || !credentials.client_secret) {
        throw new ValidationError(`OAuth client credentials for ${req.validatedParams.provider} are not configured on this deployment`);
      }

      const db = getDb();
      const state = randomToken(24);
      await db('oauth_states').insert({
        id: newId(),
        organization_id: req.actor.organizationId,
        provider: req.validatedParams.provider,
        state_hash: sha256(state),
        membership_id: req.actor.membershipId,
        redirect_uri: credentials.redirect_uri,
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      });
      sendData(res, { authorize_url: adapter.buildAuthorizeUrl({ credentials, state }), state_expires_in: 600 });
    })
  );

  // ---------- API keys ----------
  router.get(
    '/api-keys',
    requirePermission('api_keys.manage'),
    handler(async (req, res) => {
      const rows = await getDb()('api_keys')
        .where('organization_id', req.actor.organizationId)
        .orderBy('created_at', 'desc')
        .select('id', 'name', 'prefix', 'scopes', 'last_used_at', 'expires_at', 'revoked_at', 'created_at');
      sendData(res, rows.map((row) => ({ ...row, scopes: typeof row.scopes === 'string' ? JSON.parse(row.scopes) : row.scopes })));
    })
  );

  router.post(
    '/api-keys',
    requirePermission('api_keys.manage'),
    validate({ body: apiKeySchema }),
    handler(async (req, res) => {
      const db = getDb();
      const secret = `gvz_${randomToken(24)}`;
      const id = newId();
      await db('api_keys').insert({
        id,
        organization_id: req.actor.organizationId,
        name: req.validatedBody.name,
        prefix: secret.slice(0, 12),
        key_hash: sha256(secret),
        scopes: JSON.stringify(req.validatedBody.scopes),
        created_by: req.actor.membershipId,
        expires_at: req.validatedBody.expires_at ?? null,
      });
      await recordAudit({ ...auditFromRequest(req), action: 'api_key.created', entityType: 'api_key', entityId: id, after: { name: req.validatedBody.name, scopes: req.validatedBody.scopes } });
      // The plaintext key is returned exactly once.
      sendData(res, { id, api_key: secret, name: req.validatedBody.name, scopes: req.validatedBody.scopes }, { status: 201 });
    })
  );

  router.delete(
    '/api-keys/:id',
    requirePermission('api_keys.manage'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      await db('api_keys').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).update({ revoked_at: db.fn.now() });
      sendData(res, { revoked: true });
    })
  );

  // ---------- Outbound webhooks ----------
  router.get(
    '/webhook-endpoints',
    requirePermission('webhooks.manage'),
    handler(async (req, res) => {
      const rows = await getDb()('webhook_endpoints')
        .where('organization_id', req.actor.organizationId)
        .whereNull('deleted_at')
        .select('id', 'name', 'target_url', 'event_types', 'status', 'consecutive_failures', 'last_delivery_at', 'created_at');
      sendData(res, rows.map((row) => ({ ...row, event_types: typeof row.event_types === 'string' ? JSON.parse(row.event_types) : row.event_types })));
    })
  );

  router.post(
    '/webhook-endpoints',
    requirePermission('webhooks.manage'),
    validate({ body: webhookEndpointSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const secret = randomToken(32);
      const encrypted = encryptSecret(secret);
      const id = newId();
      await db('webhook_endpoints').insert({
        id,
        organization_id: req.actor.organizationId,
        name: req.validatedBody.name,
        target_url: req.validatedBody.target_url,
        event_types: JSON.stringify(req.validatedBody.event_types),
        secret_key_version: encrypted.key_version,
        secret_ciphertext: encrypted.ciphertext,
        secret_iv: encrypted.iv,
        secret_auth_tag: encrypted.auth_tag,
        status: 'active',
        created_by: req.actor.membershipId,
      });
      sendData(res, { id, signing_secret: secret, name: req.validatedBody.name, event_types: req.validatedBody.event_types }, { status: 201 });
    })
  );

  router.get(
    '/webhook-deliveries',
    requirePermission('webhooks.manage'),
    validate({ query: paginationSchema.extend({ status: z.string().max(24).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('webhook_deliveries').where('organization_id', req.actor.organizationId);
      if (req.validatedQuery.status) query = query.where('status', req.validatedQuery.status);
      const rows = await query.orderBy('created_at', 'desc').limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.get(
    '/dead-letters',
    requirePermission('integrations.read'),
    validate({ query: paginationSchema }),
    handler(async (req, res) => {
      const rows = await getDb()('dead_letter_jobs')
        .where('organization_id', req.actor.organizationId)
        .where('status', 'open')
        .orderBy('created_at', 'desc')
        .limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.post(
    '/dead-letters/:id/retry',
    requirePermission('integrations.manage'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const entry = await db('dead_letter_jobs').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!entry) throw new NotFoundError('Dead letter job');
      const { enqueueJob } = await import('../../core/jobs.js');
      await enqueueJob({
        organizationId: req.actor.organizationId,
        jobType: entry.job_type,
        payload: typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload,
        queue: entry.queue ?? 'default',
      });
      await db('dead_letter_jobs').where('id', entry.id).update({ status: 'requeued', resolved_at: db.fn.now(), resolved_by_membership_id: req.actor.membershipId });
      sendData(res, { requeued: true });
    })
  );

  return router;
}
