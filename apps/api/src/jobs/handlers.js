import { getDb } from '@govyzer/database';
import { newId } from '@govyzer/domain';
import { registerJobHandler } from '../core/jobs.js';
import { JOB_TYPES } from './index.js';
import { executePublication, executeUnpublish, loadCredentials } from '../modules/portals/service.js';
import { processSlaEvent } from '../modules/leads/sla.js';
import { expireReservation, expireHold } from '../modules/offplan/inventory.js';
import { runWorkflow } from '../modules/workflows/engine.js';
import { logger } from '../core/logger.js';
import { sendMail } from '../core/mailer.js';
import { getIntegrationAdapter, requestJson } from '@govyzer/integrations';
import { createHmac } from 'node:crypto';
import { decryptSecret } from '../core/crypto.js';

registerJobHandler(JOB_TYPES.PORTAL_PUBLISH, async ({ payload, db }) => {
  await executePublication({ db, publicationId: payload.publication_id });
});

registerJobHandler(JOB_TYPES.PORTAL_UNPUBLISH, async ({ payload, db }) => {
  await executeUnpublish({ db, publicationId: payload.publication_id });
});

registerJobHandler(JOB_TYPES.PORTAL_STATUS_REFRESH, async ({ payload, db }) => {
  const publications = await db('portal_publications')
    .where('portal_account_id', payload.portal_account_id)
    .where('status', 'published')
    .limit(50);
  for (const publication of publications) {
    const { getPortalAdapter } = await import('@govyzer/integrations');
    const adapter = getPortalAdapter(publication.provider_code);
    const account = await db('portal_accounts').where('id', publication.portal_account_id).first();
    if (!adapter || !account) continue;
    const credentials = await loadCredentials({ organizationId: account.organization_id, connectionId: account.integration_connection_id });
    const status = await adapter.fetchPublicationStatus({ credentials, externalId: publication.external_listing_id });
    await db('portal_publications').where('id', publication.id).update({
      last_synced_at: db.fn.now(),
      external_url: status.externalUrl ?? publication.external_url,
    });
  }
});

registerJobHandler(JOB_TYPES.PORTAL_PULL_LEADS, async ({ payload, db }) => {
  const { getPortalAdapter } = await import('@govyzer/integrations');
  const account = await db('portal_accounts').where('id', payload.portal_account_id).first();
  if (!account) return;
  const adapter = getPortalAdapter(account.provider_code);
  if (!adapter?.getCapabilities().leadPolling) return;
  const credentials = await loadCredentials({ organizationId: account.organization_id, connectionId: account.integration_connection_id });
  const result = await adapter.pullLeads({ credentials, since: account.last_success_at });
  logger.info('portal_lead_pull', { provider: account.provider_code, status: result.status });
});

registerJobHandler(JOB_TYPES.LEAD_SLA_CHECK, async ({ payload, db, organizationId }) => {
  await processSlaEvent({ db, organizationId, slaEventId: payload.sla_event_id });
});

registerJobHandler(JOB_TYPES.RESERVATION_EXPIRE, async ({ payload, db }) => {
  await expireReservation({ db, reservationId: payload.reservation_id });
});

registerJobHandler(JOB_TYPES.HOLD_EXPIRE, async ({ payload, db }) => {
  await expireHold({ db, holdId: payload.hold_id });
});

registerJobHandler(JOB_TYPES.WORKFLOW_RUN, async ({ payload, db, organizationId }) => {
  await runWorkflow({
    db,
    organizationId,
    workflowId: payload.workflow_id,
    versionId: payload.version_id,
    entityType: payload.entity_type,
    entityId: payload.entity_id,
    triggerPayload: payload.trigger_payload ?? {},
    depth: payload.depth ?? 0,
  });
});

registerJobHandler(JOB_TYPES.WORKFLOW_RESUME, async ({ payload, db, organizationId }) => {
  await runWorkflow({
    db,
    organizationId,
    runId: payload.run_id,
    entityType: payload.entity_type ?? null,
    entityId: payload.entity_id ?? null,
    startPosition: payload.resume_from_position ?? 0,
  });
});

registerJobHandler(JOB_TYPES.REMINDER_DISPATCH, async ({ payload, db, organizationId }) => {
  if (payload.entity_type === 'meeting') {
    const meeting = await db('meetings').where({ id: payload.entity_id, organization_id: organizationId }).whereNull('deleted_at').first();
    if (!meeting || meeting.status !== 'scheduled') return;
    if (meeting.organizer_membership_id) {
      await db('notifications').insert({
        id: newId(),
        organization_id: organizationId,
        membership_id: meeting.organizer_membership_id,
        type: 'meeting.reminder',
        title: 'Upcoming meeting',
        body: `${meeting.title} starts soon.`,
        entity_type: 'meeting',
        entity_id: meeting.id,
        priority: 'high',
      });
    }
  }
  if (payload.entity_type === 'task') {
    const task = await db('tasks').where({ id: payload.entity_id, organization_id: organizationId }).whereNull('deleted_at').first();
    if (!task || task.status === 'completed' || !task.assigned_membership_id) return;
    await db('notifications').insert({
      id: newId(),
      organization_id: organizationId,
      membership_id: task.assigned_membership_id,
      type: 'task.due',
      title: 'Task due',
      body: task.title,
      entity_type: 'task',
      entity_id: task.id,
    });
  }
});

registerJobHandler(JOB_TYPES.WEBHOOK_DELIVER, async ({ payload, db }) => {
  const delivery = await db('webhook_deliveries').where('id', payload.delivery_id).first();
  if (!delivery || delivery.status === 'delivered') return;
  const endpoint = await db('webhook_endpoints').where('id', delivery.endpoint_id).first();
  if (!endpoint || endpoint.status !== 'active') return;

  const body = typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);
  let signature = null;
  if (endpoint.secret_ciphertext) {
    const secret = decryptSecret({
      key_version: endpoint.secret_key_version,
      ciphertext: endpoint.secret_ciphertext,
      iv: endpoint.secret_iv,
      auth_tag: endpoint.secret_auth_tag,
    });
    signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  const startedAt = Date.now();
  const response = await requestJson(endpoint.target_url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-govyzer-signature': signature } : {}),
      'x-govyzer-event': delivery.event_type,
      'x-govyzer-delivery': delivery.id,
    },
    body,
    provider: 'webhook',
    retries: 0,
  }).catch((error) => ({ ok: false, status: 0, body: { message: error.message } }));

  const attempts = Number(delivery.attempts ?? 0) + 1;
  const exhausted = attempts >= Number(delivery.max_attempts ?? 6);

  await db('webhook_deliveries')
    .where('id', delivery.id)
    .update({
      status: response.ok ? 'delivered' : exhausted ? 'dead' : 'pending',
      attempts,
      response_status: response.status ?? null,
      response_body: JSON.stringify(response.body ?? {}).slice(0, 2000),
      duration_ms: Date.now() - startedAt,
      delivered_at: response.ok ? db.fn.now() : null,
      run_after: response.ok ? db.fn.now() : new Date(Date.now() + Math.min(2 ** attempts * 1000, 30 * 60 * 1000)),
      last_error: response.ok ? null : `HTTP ${response.status}`,
    });

  if (!response.ok) {
    const failures = Number(endpoint.consecutive_failures ?? 0) + 1;
    await db('webhook_endpoints').where('id', endpoint.id).update({
      consecutive_failures: failures,
      status: failures >= 15 ? 'disabled' : endpoint.status,
      disabled_at: failures >= 15 ? db.fn.now() : null,
    });
  } else {
    await db('webhook_endpoints').where('id', endpoint.id).update({ consecutive_failures: 0, last_delivery_at: db.fn.now() });
  }
});

registerJobHandler(JOB_TYPES.WEBHOOK_PROCESS, async ({ payload, db }) => {
  if (payload.kind === 'outbound_whatsapp') {
    const connection = await db('integration_connections').where('id', payload.connection_id).first();
    if (!connection) return;
    const adapter = getIntegrationAdapter(connection.provider);
    if (!adapter?.sendMessage) return;
    const credentialRow = await db('integration_credentials').where({ connection_id: connection.id, credential_type: 'api_key' }).first();
    const credentials = credentialRow ? JSON.parse(decryptSecret(credentialRow)) : {};
    await adapter.sendMessage({ credentials, to: payload.to, body: payload.body });
    return;
  }

  const { processWebhookReceipt } = await import('../modules/webhooks/service.js');
  await processWebhookReceipt({ db, receiptId: payload.receipt_id });
});

registerJobHandler(JOB_TYPES.DOCUMENT_GENERATE, async ({ payload, organizationId }) => {
  const { generateDocument } = await import('../modules/documents/service.js');
  await generateDocument({
    organizationId,
    actor: { membershipId: payload.actor_membership_id ?? null, referencePrefix: payload.reference_prefix ?? 'GVZ' },
    payload: payload.document,
  });
});

registerJobHandler(JOB_TYPES.AI_ENRICH, async ({ payload, organizationId }) => {
  const { runAiFeature } = await import('../modules/ai/service.js');
  await runAiFeature({
    organizationId,
    actor: { membershipId: payload.membership_id ?? null },
    feature: payload.feature,
    entityType: payload.entity_type,
    entityId: payload.entity_id,
    input: payload.input ?? {},
  }).catch((error) => logger.warn('ai_enrichment_failed', { feature: payload.feature, error: error.message }));
});

registerJobHandler(JOB_TYPES.SALES_EVENT_AGGREGATE, async ({ db, organizationId }) => {
  const { bumpFeedVersion } = await import('../modules/sales-screen/service.js');
  await bumpFeedVersion({ db, organizationId });
});

registerJobHandler(JOB_TYPES.REPORT_RUN, async ({ payload, db, organizationId }) => {
  const { runReport } = await import('../modules/reports/service.js');
  const schedule = await db('report_schedules').where({ id: payload.schedule_id, organization_id: organizationId }).first();
  if (!schedule || !schedule.is_active) return;
  const filters = typeof schedule.filters === 'string' ? JSON.parse(schedule.filters ?? '{}') : schedule.filters ?? {};
  const report = await runReport({ organizationId, code: schedule.report_code, filters, actor: { isPlatformAdmin: true, organizationId, permissions: new Set(), recordScope: 'organization' } });
  const recipients = typeof schedule.recipients === 'string' ? JSON.parse(schedule.recipients) : schedule.recipients ?? [];
  for (const recipient of recipients) {
    await sendMail({
      to: recipient,
      subject: `${schedule.name} — scheduled report`,
      html: `<p>Rows: ${report.rows.length}</p><pre>${JSON.stringify(report.rows.slice(0, 20), null, 2)}</pre>`,
      text: JSON.stringify(report.rows.slice(0, 20)),
    });
  }
  await db('report_schedules').where('id', schedule.id).update({ last_run_at: db.fn.now() });
});

registerJobHandler(JOB_TYPES.EXPORT_RUN, async ({ payload, db, organizationId }) => {
  const { runExport } = await import('../modules/reports/service.js');
  await runExport({ db, organizationId, exportId: payload.export_id });
});

registerJobHandler(JOB_TYPES.DATA_RETENTION, async ({ db }) => {
  const now = new Date();
  await db('portal_raw_payloads').where('expires_at', '<', now).delete();
  await db('idempotency_keys').where('expires_at', '<', now).delete();
  await db('rate_limit_buckets').where('expires_at', '<', now).delete();
  await db('sessions').where('expires_at', '<', new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)).delete();
  await db('password_reset_tokens').where('expires_at', '<', now).delete();
  await db('email_verification_tokens').where('expires_at', '<', now).delete();
  await db('oauth_states').where('expires_at', '<', now).delete();
});

export function ensureJobHandlersRegistered() {
  return true;
}
