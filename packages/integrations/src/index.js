export * from './contract.js';
export * from './http.js';
export * from './registry.js';
export * from './portals/mapping.js';
export * from './portals/feed.js';
export { UaePortalAdapter, propertyFinderAdapter, bayutAdapter, dubizzleAdapter } from './portals/uae-portal.js';
export { websiteAdapter, xmlFeedAdapter, jsonFeedAdapter, genericRestAdapter } from './portals/generic.js';
export { whatsyncsAdapter, WhatsyncsAdapter } from './messaging/whatsyncs.js';
export { whatsappCloudAdapter, WhatsAppCloudAdapter } from './messaging/whatsapp-cloud.js';
export * from './messaging/normalize.js';
export {
  gmailAdapter,
  outlookAdapter,
  googleCalendarAdapter,
  microsoftCalendarAdapter,
  genericEmailAdapter,
  genericTelephonyAdapter,
} from './messaging/email-calendar.js';
export { docusignAdapter, manualSignatureAdapter } from './signature/docusign.js';
