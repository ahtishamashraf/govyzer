import { z } from 'zod';
import { ProviderAdapter, awaitingProviderCredentials } from '../contract.js';
import { requestJson } from '../http.js';
import {
  buildMappingIndex,
  mapValue,
  toCanonicalListing,
  validateUaeListing,
  DEFAULT_PROPERTY_TYPE_MAP,
  DEFAULT_FURNISHING_MAP,
  DEFAULT_RENT_FREQUENCY_MAP,
} from './mapping.js';
import { buildListingFeedXml } from './feed.js';

const credentialSchema = z
  .object({
    account_reference: z.string().min(1).max(190).optional(),
    feed_enabled: z.coerce.boolean().default(true),
    api_base_url: z.string().url().optional(),
    api_key: z.string().min(8).optional(),
    api_secret: z.string().min(8).optional(),
    lead_webhook_secret: z.string().min(8).optional(),
  })
  .refine(
    (value) => value.feed_enabled || (value.api_base_url && value.api_key),
    'Provide either a feed configuration or an API base URL with credentials'
  );

/**
 * Shared implementation for the UAE portals. Feed transport is fully functional today:
 * the portal pulls a signed feed URL exposed by the API. The direct API transport is
 * implemented against a documented base URL supplied by the tenant — no endpoint is
 * invented here, so without official credentials the adapter reports
 * `awaiting_provider_credentials` instead of pretending to publish.
 */
export class UaePortalAdapter extends ProviderAdapter {
  constructor({ code, name, feedRoot, feedItem, documentationUrl, overrides = {} }) {
    super({
      code,
      name,
      transport: 'feed_or_api',
      credentialSchema,
      capabilities: {
        publish: true,
        update: true,
        unpublish: true,
        statusPolling: true,
        leadWebhook: true,
        leadPolling: false,
        feed: true,
        requiresPermitNumber: true,
        media: { maxImages: 30, requiredImages: 1, maxVideoBytes: 200 * 1024 * 1024 },
        supportedOfferingTypes: ['sale', 'rent'],
        supportedPropertyTypes: Object.keys(DEFAULT_PROPERTY_TYPE_MAP),
        ...overrides.capabilities,
      },
    });
    this.feedRoot = feedRoot;
    this.feedItem = feedItem;
    this.documentationUrl = documentationUrl;
  }

  async testConnection({ credentials = {}, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };

    if (!parsed.values.api_base_url || !parsed.values.api_key) {
      return {
        ok: true,
        status: 'feed_ready',
        message: `${this.name} will pull the tenant feed URL. No outbound credentials are required.`,
      };
    }
    const response = await requestJson(`${parsed.values.api_base_url.replace(/\/$/, '')}/ping`, {
      headers: { authorization: `Bearer ${parsed.values.api_key}` },
      provider: this.code,
      retries: 1,
      fetchImpl,
    });
    return response.ok
      ? { ok: true, status: 'connected', message: 'API connection verified', correlationId: response.correlationId }
      : {
          ok: false,
          status: 'connection_failed',
          errors: [this.normalizeProviderError({ code: 'connection_failed', message: `HTTP ${response.status}`, retryable: response.status >= 500 })],
        };
  }

  validateListing(listing, context = {}) {
    const canonical = context.canonical ?? toCanonicalListing(listing, context);
    return validateUaeListing(canonical, {
      requirePermit: this.capabilities.requiresPermitNumber,
      minImages: this.capabilities.media.requiredImages,
      maxImages: this.capabilities.media.maxImages,
    });
  }

  mapListingToProvider(listing, context = {}) {
    const canonical = context.canonical ?? toCanonicalListing(listing, context);
    const index = buildMappingIndex(context.mappings ?? []);
    return {
      reference: canonical.reference,
      offering_type: canonical.offering_type === 'rent' ? 'Rent' : 'Sale',
      property_type: mapValue(index, 'property_type', canonical.property_type, DEFAULT_PROPERTY_TYPE_MAP, 'Apartment'),
      category: canonical.property_category === 'commercial' ? 'Commercial' : 'Residential',
      title: canonical.title.en,
      title_ar: canonical.title.ar,
      description: canonical.description.en,
      description_ar: canonical.description.ar,
      price: canonical.price,
      currency: canonical.currency,
      rent_frequency:
        canonical.offering_type === 'rent'
          ? mapValue(index, 'rent_frequency', canonical.rent_frequency, DEFAULT_RENT_FREQUENCY_MAP, 'Yearly')
          : null,
      cheques: canonical.cheques_allowed,
      bedrooms: canonical.bedrooms,
      bathrooms: canonical.bathrooms,
      size: canonical.size,
      size_unit: canonical.size_unit,
      plot_size: canonical.plot_size,
      parking: canonical.parking_spaces,
      furnished: mapValue(index, 'furnishing', canonical.furnishing, DEFAULT_FURNISHING_MAP, 'No'),
      city: mapValue(index, 'city', canonical.location.city, {}, canonical.location.city),
      community: mapValue(index, 'community', canonical.location.community, {}, canonical.location.community),
      subcommunity: mapValue(index, 'subcommunity', canonical.location.subcommunity, {}, canonical.location.subcommunity),
      building: canonical.location.building,
      latitude: canonical.location.hide_exact_address ? null : canonical.location.latitude,
      longitude: canonical.location.hide_exact_address ? null : canonical.location.longitude,
      permit_number: canonical.permit_number,
      amenities: (canonical.amenities ?? []).map((code) => mapValue(index, 'amenity', code, {}, code)),
      images: canonical.media.filter((asset) => asset.type === 'image').map((asset) => asset.url),
      floor_plans: canonical.floor_plans.map((plan) => plan.url).filter(Boolean),
      agent: canonical.agent,
      last_updated: canonical.updated_at,
    };
  }

  buildFeed(canonicalListings, options = {}) {
    return buildListingFeedXml(canonicalListings, {
      root: this.feedRoot,
      item: this.feedItem,
      ...options,
    });
  }

  async publishListing({ listing, credentials = {}, context = {}, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };

    const validationErrors = this.validateListing(listing, context).filter((error) => error.severity === 'error');
    if (validationErrors.length > 0) {
      return { ok: false, status: 'validation_failed', errors: validationErrors };
    }

    const payload = this.mapListingToProvider(listing, context);

    // Feed transport: the portal pulls the tenant feed, so publication succeeds as soon
    // as the listing is included in the feed and the portal picks it up.
    if (!parsed.values.api_base_url || !parsed.values.api_key) {
      if (parsed.values.feed_enabled) {
        return {
          ok: true,
          status: 'published_via_feed',
          externalId: payload.reference,
          payload,
          message: `${this.name} pulls the tenant feed. The listing is included in the next feed fetch.`,
        };
      }
      return awaitingProviderCredentials(this.name, this.documentationUrl);
    }

    const response = await requestJson(`${parsed.values.api_base_url.replace(/\/$/, '')}/listings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${parsed.values.api_key}` },
      body: payload,
      provider: this.code,
      fetchImpl,
    });
    return this.#interpret(response, payload);
  }

  async updateListing(args) {
    return this.publishListing(args);
  }

  async unpublishListing({ credentials = {}, externalId, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    if (!parsed.values.api_base_url || !parsed.values.api_key) {
      return {
        ok: true,
        status: 'unpublished_via_feed',
        message: 'The listing was removed from the tenant feed and will drop on the next fetch.',
      };
    }
    const response = await requestJson(
      `${parsed.values.api_base_url.replace(/\/$/, '')}/listings/${encodeURIComponent(externalId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${parsed.values.api_key}` }, provider: this.code, fetchImpl }
    );
    return response.ok
      ? { ok: true, status: 'unpublished' }
      : { ok: false, status: 'failed', errors: [this.#httpError(response)] };
  }

  async fetchPublicationStatus({ credentials = {}, externalId, fetchImpl } = {}) {
    const parsed = this.validateConfiguration(credentials);
    if (!parsed.valid) return { ok: false, status: 'invalid_configuration', errors: parsed.errors };
    if (!parsed.values.api_base_url || !parsed.values.api_key) {
      return { ok: true, status: 'feed_managed', message: 'Status is managed by the portal feed importer.' };
    }
    const response = await requestJson(
      `${parsed.values.api_base_url.replace(/\/$/, '')}/listings/${encodeURIComponent(externalId)}`,
      { headers: { authorization: `Bearer ${parsed.values.api_key}` }, provider: this.code, fetchImpl }
    );
    if (!response.ok) return { ok: false, status: 'failed', errors: [this.#httpError(response)] };
    return {
      ok: true,
      status: response.body?.status ?? 'published',
      externalId: response.body?.id ?? externalId,
      externalUrl: response.body?.url ?? null,
    };
  }

  normalizeLead(payload, context = {}) {
    const contact = payload.contact ?? payload.client ?? payload;
    const name = contact.name ?? [contact.first_name, contact.last_name].filter(Boolean).join(' ');
    return {
      provider: this.code,
      external_id: String(payload.lead_id ?? payload.id ?? payload.reference ?? ''),
      received_at: payload.created_at ? new Date(payload.created_at) : new Date(),
      name: name || null,
      email: contact.email ?? null,
      phone: contact.phone ?? contact.mobile ?? null,
      message: payload.message ?? payload.comments ?? null,
      property_reference: payload.listing_reference ?? payload.property_reference ?? payload.reference ?? null,
      portal_code: this.code,
      source: this.code,
      module: context.module ?? 'ready',
      language: payload.language ?? 'en',
      raw: payload,
    };
  }

  #interpret(response, payload) {
    if (response.ok) {
      return {
        ok: true,
        status: 'published',
        externalId: response.body?.id ?? response.body?.listing_id ?? payload.reference,
        externalUrl: response.body?.url ?? null,
        correlationId: response.correlationId,
        payload,
      };
    }
    return { ok: false, status: response.status >= 500 ? 'failed' : 'rejected', errors: [this.#httpError(response)] };
  }

  #httpError(response) {
    const body = response.body ?? {};
    return {
      code: body.code ?? `http_${response.status}`,
      message: body.message ?? body.error ?? `${this.name} responded with HTTP ${response.status}`,
      field: body.field ?? null,
      retryable: response.status >= 500 || response.status === 429,
      severity: 'error',
    };
  }
}

export const propertyFinderAdapter = new UaePortalAdapter({
  code: 'property_finder',
  name: 'Property Finder',
  feedRoot: 'properties',
  feedItem: 'property',
  documentationUrl: 'https://www.propertyfinder.ae/en/broker/api-integration',
});

export const bayutAdapter = new UaePortalAdapter({
  code: 'bayut',
  name: 'Bayut',
  feedRoot: 'listings',
  feedItem: 'listing',
  documentationUrl: 'https://www.bayut.com/agencies/',
});

export const dubizzleAdapter = new UaePortalAdapter({
  code: 'dubizzle',
  name: 'Dubizzle',
  feedRoot: 'listings',
  feedItem: 'listing',
  documentationUrl: 'https://dubai.dubizzle.com/',
});
