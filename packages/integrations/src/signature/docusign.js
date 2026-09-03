import { z } from 'zod';
import { requestJson } from '../http.js';

/**
 * DocuSign-compatible signature adapter. Base URI and account id come from the tenant's
 * own DocuSign account, so the same adapter also drives compatible providers.
 */
export const docusignAdapter = {
  code: 'docusign',
  name: 'DocuSign',
  category: 'signature',
  credentialSchema: z.object({
    base_uri: z.string().url(),
    account_id: z.string().min(3),
    access_token: z.string().min(20),
    webhook_secret: z.string().min(8).optional(),
  }),
  getCapabilities: () => ({ sendForSignature: true, statusWebhook: true, downloadSigned: true, embeddedSigning: false }),
  validateConfiguration(config = {}) {
    const result = this.credentialSchema.safeParse(config);
    return result.success
      ? { valid: true, values: result.data, errors: [] }
      : { valid: false, values: null, errors: result.error.issues.map((issue) => ({ code: 'invalid_configuration', field: issue.path.join('.'), message: issue.message, retryable: false, severity: 'error' })) };
  },
  async testConnection({ credentials = {}, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    const response = await requestJson(
      `${parsed.values.base_uri.replace(/\/$/, '')}/restapi/v2.1/accounts/${parsed.values.account_id}`,
      { headers: { authorization: `Bearer ${parsed.values.access_token}` }, provider: this.code, retries: 1, fetchImpl }
    );
    return response.ok
      ? { ok: true, status: 'connected', identity: response.body?.accountName ?? null }
      : { ok: false, status: 'connection_failed', errors: [{ code: `http_${response.status}`, message: `HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }] };
  },
  async sendForSignature({ credentials = {}, document, signers = [], fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    const response = await requestJson(
      `${parsed.values.base_uri.replace(/\/$/, '')}/restapi/v2.1/accounts/${parsed.values.account_id}/envelopes`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${parsed.values.access_token}` },
        body: {
          emailSubject: document.title,
          status: 'sent',
          documents: [
            {
              documentBase64: document.contentBase64,
              name: document.title,
              fileExtension: 'pdf',
              documentId: '1',
            },
          ],
          recipients: {
            signers: signers.map((signer, index) => ({
              email: signer.email,
              name: signer.name,
              recipientId: String(index + 1),
              routingOrder: String(index + 1),
            })),
          },
        },
        provider: this.code,
        fetchImpl,
      }
    );
    return response.ok
      ? { ok: true, status: 'sent', externalId: response.body?.envelopeId ?? null }
      : { ok: false, status: 'failed', errors: [{ code: `http_${response.status}`, message: response.body?.message ?? `HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }] };
  },
  normalizeStatusWebhook(payload) {
    const status = String(payload?.event ?? payload?.status ?? '').toLowerCase();
    const map = { 'envelope-sent': 'sent', 'envelope-delivered': 'delivered', 'envelope-completed': 'completed', 'envelope-declined': 'declined', 'envelope-voided': 'voided' };
    return {
      external_id: payload?.data?.envelopeId ?? payload?.envelopeId ?? null,
      status: map[status] ?? 'pending',
      completed_at: status === 'envelope-completed' ? new Date() : null,
      raw: payload,
    };
  },
};

/** Manual signature tracking used when no e-signature provider is connected. */
export const manualSignatureAdapter = {
  code: 'manual',
  name: 'Manual Signature',
  category: 'signature',
  credentialSchema: z.object({}),
  getCapabilities: () => ({ sendForSignature: false, statusWebhook: false, downloadSigned: true, embeddedSigning: false }),
  validateConfiguration: () => ({ valid: true, values: {}, errors: [] }),
  async testConnection() {
    return { ok: true, status: 'connected', message: 'Signatures are tracked manually' };
  },
};
