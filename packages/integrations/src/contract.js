import { z } from 'zod';

/**
 * Every portal adapter implements this contract. The CRM only ever talks to this
 * interface, so adding a portal never touches listing, lead or job code.
 */
export const CAPABILITY_SHAPE = Object.freeze({
  publish: false,
  update: false,
  unpublish: false,
  statusPolling: false,
  leadWebhook: false,
  leadPolling: false,
  feed: false,
  media: { maxImages: 20, maxVideoBytes: null, requiredImages: 1 },
  supportedOfferingTypes: ['sale', 'rent'],
  supportedPropertyTypes: [],
  requiresPermitNumber: false,
});

export const normalizedErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string().nullable().optional(),
  retryable: z.boolean().default(false),
  severity: z.enum(['error', 'warning']).default('error'),
});

export class ProviderAdapter {
  constructor({ code, name, transport = 'feed', capabilities = {}, credentialSchema = z.object({}) }) {
    this.code = code;
    this.name = name;
    this.transport = transport;
    this.capabilities = { ...CAPABILITY_SHAPE, ...capabilities };
    this.credentialSchema = credentialSchema;
  }

  getCapabilities() {
    return this.capabilities;
  }

  /** Validates tenant supplied configuration before anything is stored. */
  validateConfiguration(config = {}) {
    const result = this.credentialSchema.safeParse(config);
    if (result.success) return { valid: true, values: result.data, errors: [] };
    return {
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

  // eslint-disable-next-line no-unused-vars
  async testConnection(context) {
    return { ok: false, status: 'not_implemented', message: `${this.code} has no connection test` };
  }

  /** Portal specific listing validation. Returns normalized, actionable errors. */
  // eslint-disable-next-line no-unused-vars
  validateListing(listing, context = {}) {
    return [];
  }

  // eslint-disable-next-line no-unused-vars
  mapListingToProvider(listing, context = {}) {
    throw new Error(`${this.code} does not implement mapListingToProvider`);
  }

  async publishListing() {
    return this.#unsupported('publish');
  }

  async updateListing() {
    return this.#unsupported('update');
  }

  async unpublishListing() {
    return this.#unsupported('unpublish');
  }

  async fetchPublicationStatus() {
    return this.#unsupported('statusPolling');
  }

  // eslint-disable-next-line no-unused-vars
  receiveLead(payload, context = {}) {
    return this.normalizeLead(payload, context);
  }

  async pullLeads() {
    return this.#unsupported('leadPolling');
  }

  // eslint-disable-next-line no-unused-vars
  normalizeLead(payload, context = {}) {
    throw new Error(`${this.code} does not implement normalizeLead`);
  }

  normalizeProviderError(error) {
    if (error?.code && error?.message) return error;
    return {
      code: 'provider_error',
      message: error?.message ?? String(error),
      field: null,
      retryable: true,
      severity: 'error',
    };
  }

  #unsupported(capability) {
    return {
      ok: false,
      status: 'unsupported',
      errors: [
        {
          code: 'capability_unavailable',
          message: `${this.name} does not support ${capability} through this connection. Configure the provider transport or use the feed integration.`,
          field: null,
          retryable: false,
          severity: 'error',
        },
      ],
    };
  }
}

/**
 * Marker used when an adapter is complete except for the provider-specific transport,
 * which needs official credentials or documentation from the portal.
 */
export function awaitingProviderCredentials(providerName, docsUrl = null) {
  return {
    ok: false,
    status: 'awaiting_provider_credentials',
    errors: [
      {
        code: 'awaiting_provider_credentials',
        message: `${providerName} API transport is configured but no verified API base URL and credentials are present. Add them in Integrations, or publish through the feed transport.`,
        field: 'api_base_url',
        retryable: false,
        severity: 'error',
        documentation_url: docsUrl,
      },
    ],
  };
}
