import { propertyFinderAdapter, bayutAdapter, dubizzleAdapter } from './portals/uae-portal.js';
import { websiteAdapter, xmlFeedAdapter, jsonFeedAdapter, genericRestAdapter } from './portals/generic.js';
import { whatsyncsAdapter } from './messaging/whatsyncs.js';
import { whatsappCloudAdapter } from './messaging/whatsapp-cloud.js';
import {
  gmailAdapter,
  outlookAdapter,
  googleCalendarAdapter,
  microsoftCalendarAdapter,
  genericEmailAdapter,
  genericTelephonyAdapter,
} from './messaging/email-calendar.js';
import { docusignAdapter, manualSignatureAdapter } from './signature/docusign.js';

const portalAdapters = new Map(
  [propertyFinderAdapter, bayutAdapter, dubizzleAdapter, websiteAdapter, xmlFeedAdapter, jsonFeedAdapter, genericRestAdapter].map(
    (adapter) => [adapter.code, adapter]
  )
);

const integrationAdapters = new Map(
  [
    whatsyncsAdapter,
    whatsappCloudAdapter,
    gmailAdapter,
    outlookAdapter,
    googleCalendarAdapter,
    microsoftCalendarAdapter,
    genericEmailAdapter,
    genericTelephonyAdapter,
    docusignAdapter,
    manualSignatureAdapter,
  ].map((adapter) => [adapter.code, adapter])
);

/** Extendable registry so a new international portal is a single register call. */
export function registerPortalAdapter(adapter) {
  portalAdapters.set(adapter.code, adapter);
  return adapter;
}

export function registerIntegrationAdapter(adapter) {
  integrationAdapters.set(adapter.code, adapter);
  return adapter;
}

export function getPortalAdapter(code) {
  return portalAdapters.get(code) ?? null;
}

export function getIntegrationAdapter(code) {
  return integrationAdapters.get(code) ?? null;
}

export function listPortalAdapters() {
  return [...portalAdapters.values()].map((adapter) => ({
    code: adapter.code,
    name: adapter.name,
    transport: adapter.transport,
    capabilities: adapter.getCapabilities(),
  }));
}

export function listIntegrationAdapters() {
  return [...integrationAdapters.values()].map((adapter) => ({
    code: adapter.code,
    name: adapter.name,
    category: adapter.category ?? 'integration',
    capabilities: adapter.getCapabilities(),
  }));
}
