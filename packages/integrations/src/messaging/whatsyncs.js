import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requestJson } from '../http.js';
import { normalizedMessage, toDate } from './normalize.js';

const credentialSchema = z.object({
  base_url: z.string().url(),
  api_key: z.string().min(8),
  instance_id: z.string().max(190).optional(),
  webhook_secret: z.string().min(8).optional(),
});

/**
 * Whatsyncs messaging adapter. Base URL and credentials come from environment defaults or
 * an encrypted tenant/user connection — nothing about the transport is hardcoded.
 */
export class WhatsyncsAdapter {
  code = 'whatsyncs';
  name = 'Whatsyncs';
  channel = 'whatsapp';
  credentialSchema = credentialSchema;

  getCapabilities() {
    return {
      sendText: true,
      sendMedia: true,
      receiveWebhook: true,
      deliveryStatus: true,
      threads: true,
      templates: false,
    };
  }

  validateConfiguration(config = {}) {
    const result = credentialSchema.safeParse(config);
    return result.success
      ? { valid: true, values: result.data, errors: [] }
      : {
          valid: false,
          values: null,
          errors: result.error.issues.map((issue) => ({
            code: 'invalid_configuration',
            field: issue.path.join('.') || null,
            message: issue.message,
            retryable: false,
            severity: 'error',
          })),
        };
  }

  async testConnection({ credentials = {}, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    const response = await requestJson(`${parsed.values.base_url.replace(/\/$/, '')}/status`, {
      headers: this.#headers(parsed.values),
      provider: this.code,
      retries: 1,
      fetchImpl,
    });
    return response.ok
      ? {
          ok: true,
          status: 'connected',
          identity: response.body?.phone ?? response.body?.number ?? null,
          message: 'Whatsyncs connection verified',
        }
      : {
          ok: false,
          status: 'connection_failed',
          errors: [{ code: `http_${response.status}`, message: `Whatsyncs responded with HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }],
        };
  }

  /** Verifies the HMAC signature on an inbound webhook before anything is trusted. */
  verifyWebhookSignature({ rawBody, signature, secret }) {
    if (!secret) return { verified: false, reason: 'no_secret_configured' };
    if (!signature) return { verified: false, reason: 'missing_signature' };
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = String(signature).replace(/^sha256=/, '');
    if (expected.length !== provided.length) return { verified: false, reason: 'signature_mismatch' };
    const verified = timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    return { verified, reason: verified ? null : 'signature_mismatch' };
  }

  normalizeInbound(payload) {
    const message = payload.message ?? payload.data ?? payload;
    const direction = (message.direction ?? (message.from_me ? 'outbound' : 'inbound')).toLowerCase();
    const attachments = [];
    if (message.media_url || message.attachment_url) {
      attachments.push({
        url: message.media_url ?? message.attachment_url,
        mime_type: message.mime_type ?? null,
        file_name: message.file_name ?? null,
        size_bytes: message.size ?? null,
      });
    }
    return normalizedMessage({
      provider: this.code,
      channel: 'whatsapp',
      external_message_id: String(message.id ?? message.message_id ?? payload.id ?? ''),
      external_thread_id: String(message.chat_id ?? message.thread_id ?? message.from ?? message.to ?? '') || null,
      direction: direction === 'outbound' ? 'outbound' : 'inbound',
      from_identifier: message.from ?? message.sender ?? null,
      to_identifier: message.to ?? message.recipient ?? null,
      message_type: normalizeType(message.type),
      body: message.text ?? message.body ?? message.caption ?? null,
      attachments,
      status: normalizeStatus(message.status ?? payload.status),
      sent_at: toDate(message.timestamp ?? message.sent_at ?? payload.timestamp),
      delivered_at: toDate(message.delivered_at),
      read_at: toDate(message.read_at),
      account_identity: payload.instance_id ?? payload.account ?? null,
      provider_metadata: { event: payload.event ?? null, instance_id: payload.instance_id ?? null },
    });
  }

  async sendMessage({ credentials = {}, to, body, mediaUrl = null, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    const response = await requestJson(`${parsed.values.base_url.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: this.#headers(parsed.values),
      body: { to, text: body, media_url: mediaUrl, instance_id: parsed.values.instance_id },
      provider: this.code,
      fetchImpl,
    });
    return response.ok
      ? { ok: true, status: 'sent', externalId: response.body?.id ?? response.body?.message_id ?? null }
      : { ok: false, status: 'failed', errors: [{ code: `http_${response.status}`, message: response.body?.message ?? `HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }] };
  }

  #headers(values) {
    return { authorization: `Bearer ${values.api_key}`, 'x-instance-id': values.instance_id ?? '' };
  }
}

function normalizeType(type) {
  const value = String(type ?? 'text').toLowerCase();
  if (['image', 'document', 'audio', 'video', 'location', 'template'].includes(value)) return value;
  if (value === 'chat' || value === 'text') return 'text';
  return 'text';
}

function normalizeStatus(status) {
  const value = String(status ?? 'received').toLowerCase();
  if (['queued', 'sent', 'delivered', 'read', 'failed'].includes(value)) return value;
  return 'received';
}

export const whatsyncsAdapter = new WhatsyncsAdapter();
