import { z } from 'zod';
import { ProviderAdapter } from '../contract.js';
import { requestJson } from '../http.js';
import { toCanonicalListing, validateUaeListing, buildMappingIndex, mapValue, DEFAULT_PROPERTY_TYPE_MAP } from './mapping.js';
import { buildListingFeedXml, buildListingFeedJson } from './feed.js';

/** The tenant's own website or CRM-facing API. Publishing is a signed HTTP POST. */
export const websiteAdapter = new (class WebsiteAdapter extends ProviderAdapter {
  constructor() {
    super({
      code: 'company_website',
      name: 'Company Website',
      transport: 'api',
      credentialSchema: z.object({
        api_base_url: z.string().url(),
        api_key: z.string().min(8),
        listing_path: z.string().max(200).default('/listings'),
      }),
      capabilities: {
        publish: true,
        update: true,
        unpublish: true,
        statusPolling: false,
        leadWebhook: true,
        feed: true,
        requiresPermitNumber: false,
      },
    });
  }

  validateListing(listing, context = {}) {
    const canonical = context.canonical ?? toCanonicalListing(listing, context);
    return validateUaeListing(canonical, { requirePermit: false, minImages: 1, maxImages: 60 });
  }

  mapListingToProvider(listing, context = {}) {
    return context.canonical ?? toCanonicalListing(listing, context);
  }

  async testConnection({ credentials = {}, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    const response = await requestJson(`${parsed.values.api_base_url.replace(/\/$/, '')}/health`, {
      headers: { authorization: `Bearer ${parsed.values.api_key}` },
      provider: this.code,
      retries: 1,
      fetchImpl,
    });
    return response.ok
      ? { ok: true, status: 'connected' }
      : { ok: false, status: 'connection_failed', errors: [{ code: `http_${response.status}`, message: `Website responded with HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }] };
  }

  async publishListing({ listing, credentials = {}, context = {}, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    const errors = this.validateListing(listing, context).filter((error) => error.severity === 'error');
    if (errors.length > 0) return { ok: false, status: 'validation_failed', errors };

    const payload = this.mapListingToProvider(listing, context);
    const url = `${parsed.values.api_base_url.replace(/\/$/, '')}${parsed.values.listing_path}`;
    const response = await requestJson(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${parsed.values.api_key}` },
      body: payload,
      provider: this.code,
      fetchImpl,
    });
    return response.ok
      ? { ok: true, status: 'published', externalId: response.body?.id ?? payload.reference, externalUrl: response.body?.url ?? null, payload }
      : { ok: false, status: response.status >= 500 ? 'failed' : 'rejected', errors: [{ code: `http_${response.status}`, message: response.body?.message ?? `HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }] };
  }

  normalizeLead(payload) {
    return {
      provider: this.code,
      external_id: String(payload.id ?? payload.reference ?? ''),
      received_at: payload.created_at ? new Date(payload.created_at) : new Date(),
      name: payload.name ?? null,
      email: payload.email ?? null,
      phone: payload.phone ?? null,
      message: payload.message ?? null,
      property_reference: payload.property_reference ?? payload.listing_reference ?? null,
      source: 'website',
      module: payload.module ?? 'ready',
      utm: payload.utm ?? null,
      raw: payload,
    };
  }
})();

class FeedAdapter extends ProviderAdapter {
  constructor(format) {
    super({
      code: format === 'xml' ? 'generic_xml_feed' : 'generic_json_feed',
      name: format === 'xml' ? 'Generic XML Feed' : 'Generic JSON Feed',
      transport: 'feed',
      credentialSchema: z.object({
        feed_slug: z.string().min(3).max(60).regex(/^[a-z0-9-]+$/),
        include_unpublished: z.coerce.boolean().default(false),
        field_overrides: z.record(z.string(), z.string()).optional(),
      }),
      capabilities: { publish: true, update: true, unpublish: true, feed: true, leadWebhook: true, requiresPermitNumber: false },
    });
    this.format = format;
  }

  validateListing(listing, context = {}) {
    const canonical = context.canonical ?? toCanonicalListing(listing, context);
    return validateUaeListing(canonical, { requirePermit: false, minImages: 0, maxImages: 100 });
  }

  mapListingToProvider(listing, context = {}) {
    const canonical = context.canonical ?? toCanonicalListing(listing, context);
    const index = buildMappingIndex(context.mappings ?? []);
    return {
      ...canonical,
      property_type: mapValue(index, 'property_type', canonical.property_type, DEFAULT_PROPERTY_TYPE_MAP, canonical.property_type),
    };
  }

  buildFeed(canonicalListings, options = {}) {
    return this.format === 'xml'
      ? buildListingFeedXml(canonicalListings, options)
      : buildListingFeedJson(canonicalListings, options);
  }

  async publishListing({ listing, context = {} } = {}) {
    const errors = this.validateListing(listing, context).filter((error) => error.severity === 'error');
    if (errors.length > 0) return { ok: false, status: 'validation_failed', errors };
    return {
      ok: true,
      status: 'published_via_feed',
      externalId: listing.reference,
      message: 'The listing is included in the feed and will appear on the next consumer fetch.',
    };
  }

  async unpublishListing() {
    return { ok: true, status: 'unpublished_via_feed' };
  }

  normalizeLead(payload) {
    return {
      provider: this.code,
      external_id: String(payload.id ?? payload.external_id ?? ''),
      received_at: new Date(),
      name: payload.name ?? null,
      email: payload.email ?? null,
      phone: payload.phone ?? null,
      message: payload.message ?? null,
      property_reference: payload.property_reference ?? null,
      source: this.code,
      raw: payload,
    };
  }
}

export const xmlFeedAdapter = new FeedAdapter('xml');
export const jsonFeedAdapter = new FeedAdapter('json');

/** Fully generic REST/webhook portal: the tenant declares the endpoint and field map. */
export const genericRestAdapter = new (class GenericRestAdapter extends ProviderAdapter {
  constructor() {
    super({
      code: 'generic_rest',
      name: 'Generic REST / Webhook',
      transport: 'api',
      credentialSchema: z.object({
        api_base_url: z.string().url(),
        auth_type: z.enum(['bearer', 'header', 'basic', 'none']).default('bearer'),
        auth_token: z.string().max(4000).optional(),
        auth_header_name: z.string().max(80).default('authorization'),
        publish_path: z.string().max(200).default('/listings'),
        unpublish_path: z.string().max(200).default('/listings/{external_id}'),
        status_path: z.string().max(200).optional(),
      }),
      capabilities: { publish: true, update: true, unpublish: true, statusPolling: true, leadWebhook: true, feed: false, requiresPermitNumber: false },
    });
  }

  validateListing(listing, context = {}) {
    const canonical = context.canonical ?? toCanonicalListing(listing, context);
    return validateUaeListing(canonical, { requirePermit: false, minImages: 0, maxImages: 100 });
  }

  mapListingToProvider(listing, context = {}) {
    return context.canonical ?? toCanonicalListing(listing, context);
  }

  #headers(values) {
    switch (values.auth_type) {
      case 'bearer':
        return { authorization: `Bearer ${values.auth_token ?? ''}` };
      case 'basic':
        return { authorization: `Basic ${values.auth_token ?? ''}` };
      case 'header':
        return { [values.auth_header_name]: values.auth_token ?? '' };
      default:
        return {};
    }
  }

  async testConnection({ credentials = {}, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    const response = await requestJson(parsed.values.api_base_url, {
      headers: this.#headers(parsed.values),
      provider: this.code,
      retries: 0,
      fetchImpl,
    });
    return response.status < 500
      ? { ok: true, status: 'connected', message: `Endpoint reachable (HTTP ${response.status})` }
      : { ok: false, status: 'connection_failed', errors: [{ code: `http_${response.status}`, message: `HTTP ${response.status}`, retryable: true, severity: 'error', field: null }] };
  }

  async publishListing({ listing, credentials = {}, context = {}, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    const payload = this.mapListingToProvider(listing, context);
    const response = await requestJson(
      `${parsed.values.api_base_url.replace(/\/$/, '')}${parsed.values.publish_path}`,
      { method: 'POST', headers: this.#headers(parsed.values), body: payload, provider: this.code, fetchImpl }
    );
    return response.ok
      ? { ok: true, status: 'published', externalId: response.body?.id ?? payload.reference, payload }
      : { ok: false, status: response.status >= 500 ? 'failed' : 'rejected', errors: [{ code: `http_${response.status}`, message: response.body?.message ?? `HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }] };
  }

  normalizeLead(payload) {
    return {
      provider: this.code,
      external_id: String(payload.id ?? payload.external_id ?? ''),
      received_at: new Date(),
      name: payload.name ?? null,
      email: payload.email ?? null,
      phone: payload.phone ?? null,
      message: payload.message ?? null,
      property_reference: payload.property_reference ?? null,
      source: payload.source ?? this.code,
      raw: payload,
    };
  }
})();
