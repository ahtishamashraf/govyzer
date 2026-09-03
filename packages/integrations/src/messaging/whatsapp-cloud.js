import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requestJson } from '../http.js';
import { normalizedMessage, toDate } from './normalize.js';

const credentialSchema = z.object({
  base_url: z.string().url().default('https://graph.facebook.com/v21.0'),
  phone_number_id: z.string().min(3),
  access_token: z.string().min(20),
  app_secret: z.string().min(8).optional(),
  verify_token: z.string().min(8).optional(),
  business_account_id: z.string().max(190).optional(),
});

/** Official WhatsApp Business Cloud adapter, same normalized contract as Whatsyncs. */
export class WhatsAppCloudAdapter {
  code = 'whatsapp_cloud';
  name = 'WhatsApp Business Cloud';
  channel = 'whatsapp';
  credentialSchema = credentialSchema;

  getCapabilities() {
    return { sendText: true, sendMedia: true, receiveWebhook: true, deliveryStatus: true, threads: true, templates: true };
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
    const url = `${parsed.values.base_url.replace(/\/$/, '')}/${parsed.values.phone_number_id}`;
    const response = await requestJson(url, {
      headers: { authorization: `Bearer ${parsed.values.access_token}` },
      provider: this.code,
      retries: 1,
      fetchImpl,
    });
    return response.ok
      ? { ok: true, status: 'connected', identity: response.body?.display_phone_number ?? null }
      : { ok: false, status: 'connection_failed', errors: [{ code: `http_${response.status}`, message: response.body?.error?.message ?? `HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }] };
  }

  verifyWebhookSignature({ rawBody, signature, secret }) {
    if (!secret) return { verified: false, reason: 'no_secret_configured' };
    if (!signature) return { verified: false, reason: 'missing_signature' };
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    if (expected.length !== String(signature).length) return { verified: false, reason: 'signature_mismatch' };
    const verified = timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
    return { verified, reason: verified ? null : 'signature_mismatch' };
  }

  /** Expands a Cloud API webhook envelope into zero or more normalized messages. */
  normalizeInbound(payload) {
    const messages = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const businessNumber = value.metadata?.display_phone_number ?? null;

        for (const message of value.messages ?? []) {
          messages.push(
            normalizedMessage({
              provider: this.code,
              channel: 'whatsapp',
              external_message_id: String(message.id),
              external_thread_id: String(message.from ?? ''),
              direction: 'inbound',
              from_identifier: message.from ?? null,
              to_identifier: businessNumber,
              message_type: mapType(message.type),
              body: message.text?.body ?? message[message.type]?.caption ?? null,
              attachments: message[message.type]?.id
                ? [{ url: null, mime_type: message[message.type]?.mime_type ?? null, file_name: message[message.type]?.filename ?? null, size_bytes: null }]
                : [],
              status: 'received',
              sent_at: toDate(message.timestamp),
              delivered_at: null,
              read_at: null,
              account_identity: businessNumber,
              provider_metadata: { media_id: message[message.type]?.id ?? null },
            })
          );
        }

        for (const status of value.statuses ?? []) {
          messages.push(
            normalizedMessage({
              provider: this.code,
              channel: 'whatsapp',
              external_message_id: String(status.id),
              external_thread_id: String(status.recipient_id ?? ''),
              direction: 'outbound',
              from_identifier: businessNumber,
              to_identifier: status.recipient_id ?? null,
              message_type: 'system',
              body: null,
              attachments: [],
              status: mapStatus(status.status),
              sent_at: toDate(status.timestamp),
              delivered_at: status.status === 'delivered' ? toDate(status.timestamp) : null,
              read_at: status.status === 'read' ? toDate(status.timestamp) : null,
              account_identity: businessNumber,
              provider_metadata: { conversation: status.conversation ?? null },
            })
          );
        }
      }
    }
    return messages;
  }

  async sendMessage({ credentials = {}, to, body, template = null, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    const url = `${parsed.values.base_url.replace(/\/$/, '')}/${parsed.values.phone_number_id}/messages`;
    const payload = template
      ? { messaging_product: 'whatsapp', to, type: 'template', template }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body } };

    const response = await requestJson(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${parsed.values.access_token}` },
      body: payload,
      provider: this.code,
      fetchImpl,
    });
    return response.ok
      ? { ok: true, status: 'sent', externalId: response.body?.messages?.[0]?.id ?? null }
      : { ok: false, status: 'failed', errors: [{ code: response.body?.error?.code ? String(response.body.error.code) : `http_${response.status}`, message: response.body?.error?.message ?? `HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }] };
  }
}

function mapType(type) {
  const value = String(type ?? 'text').toLowerCase();
  return ['image', 'document', 'audio', 'video', 'location', 'template'].includes(value) ? value : 'text';
}

function mapStatus(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'sent') return 'sent';
  if (value === 'delivered') return 'delivered';
  if (value === 'read') return 'read';
  if (value === 'failed') return 'failed';
  return 'queued';
}

export const whatsappCloudAdapter = new WhatsAppCloudAdapter();
