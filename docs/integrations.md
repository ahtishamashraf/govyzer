# Integrations

Every external system is reached through an adapter. The CRM only ever talks to the adapter
contract, so adding a provider never touches listing, lead or job code.

## Provider adapter contract

`packages/integrations/src/contract.js`

| Method | Purpose |
| --- | --- |
| `validateConfiguration(config)` | Validates tenant-supplied credentials before anything is stored |
| `testConnection({credentials})` | Live health check, surfaced in the UI |
| `getCapabilities()` | What this provider supports (publish, feed, lead webhook, media limits, permit requirement) |
| `validateListing(listing, context)` | Portal-specific validation returning normalized, actionable errors |
| `mapListingToProvider(listing, context)` | Maps the canonical listing into the provider payload |
| `publishListing` / `updateListing` / `unpublishListing` | Publication lifecycle |
| `fetchPublicationStatus` | Status refresh |
| `receiveLead` / `normalizeLead` / `pullLeads` | Inbound leads |
| `normalizeProviderError(error)` | One error shape for the job runner and the UI |

Normalized error: `{ code, message, field, retryable, severity }`.

## Portals

| Provider | Code | Transport today |
| --- | --- | --- |
| Property Finder | `property_finder` | Feed (working) + API transport when the tenant supplies a verified base URL and key |
| Bayut | `bayut` | Same |
| Dubizzle | `dubizzle` | Same |
| Company website | `company_website` | Signed HTTP POST to the tenant's own API |
| Generic XML feed | `generic_xml_feed` | Feed |
| Generic JSON feed | `generic_json_feed` | Feed |
| Generic REST / webhook | `generic_rest` | Tenant-declared endpoint, auth type and paths |

**Honest status.** The feed transport is complete and works today: connecting an account
produces a signed feed URL (`/v1/public/feeds/{provider}/{token}.xml|.json`) that the portal
pulls, and inbound portal leads arrive at
`/v1/webhooks/portal/{provider}/{token}`. The direct API transport is implemented against a
base URL and credentials that the tenant supplies from their portal account; without those
the adapter returns `awaiting_provider_credentials` rather than pretending to publish. No
undocumented portal URL, authentication scheme or response shape is invented anywhere in
this repository.

### Connecting a portal

1. Integrations → Connect a portal, choose the provider and name the account.
2. Enter the account reference. Optionally add an API base URL and key.
3. The API validates the configuration, encrypts the credentials (AES-256-GCM, versioned
   key), runs `testConnection`, stores a capability snapshot and schedules sync jobs.
4. Copy the feed URL from the account row and give it to the portal.
5. Publish from a listing: validation runs per portal first and only valid listings queue.

### Field mappings

`portal_field_mappings` lets a tenant override property type, furnishing, rent frequency,
city, community, subcommunity and amenity values per account. Tenant mappings always win
over the built-in defaults, so a portal rejection can be fixed without a deployment.

## Messaging

| Provider | Code | Notes |
| --- | --- | --- |
| Whatsyncs | `whatsyncs` | First-class. Base URL, API key, instance id and webhook secret come from environment defaults or an encrypted tenant connection. HMAC-SHA256 webhook signature verification |
| WhatsApp Business Cloud | `whatsapp_cloud` | Official Graph API, `hub.challenge` verification and `x-hub-signature-256` verification |
| Gmail | `gmail` | Google OAuth 2.0 |
| Microsoft Outlook | `outlook` | Microsoft identity platform OAuth 2.0 |
| Google Calendar | `google_calendar` | Event creation |
| Microsoft Calendar | `microsoft_calendar` | Event creation |
| Generic email ingestion | `generic_email` | Any forwarder that can POST JSON |
| Telephony / call logs | `generic_telephony` | Any PBX that can POST call records |
| DocuSign | `docusign` | Envelope creation and status webhooks |

Whatsyncs and WhatsApp Business produce the **same normalized message contract**
(`normalizedMessageSchema`), so the CRM is never coupled to one provider. Messages are
matched to a contact by phone or email, attached to that contact's open lead and appended
to the unified timeline. Duplicate delivery is a no-op:
`(organization_id, provider, external_message_id)` is unique.

## Inbound webhooks

`POST /v1/webhooks/whatsapp`, `/v1/webhooks/whatsyncs`,
`/v1/webhooks/portal/{provider}/{token}`, `/v1/webhooks/signature/{provider}`.

Each endpoint verifies the signature it can, stores the raw payload with its signature
status in `webhook_receipts` and returns immediately. Processing happens in the job queue
with retries and a dead-letter state. Replays are detected by provider event id.

## Outbound webhooks and Zapier

- Create an endpoint in Integrations → API & webhooks. The signing secret is shown once;
  deliveries carry `x-govyzer-signature: sha256=<hmac>`.
- Events: `lead.created`, `lead.updated`, `listing.created`, `listing.published`,
  `meeting.created`, `deal.won`, `deal.updated` (and every other event type in
  `EVENT_TYPES`).
- Zapier action: `POST /v1/public/leads` with `x-api-key`. It deduplicates the contact and
  is idempotent on `external_id`.
- `GET /v1/public/zapier/triggers` returns the contract, and
  `GET /v1/public/zapier/sample/{trigger}` returns a real sample payload.

Example action payload:

```json
{
  "external_id": "zap-1024",
  "name": "Sara Nasser",
  "phone": "0509998877",
  "email": "sara@example.ae",
  "source": "zapier",
  "property_reference": "LUX-LS-2601-000042",
  "message": "Requesting a viewing this week"
}
```

## AI

OpenAI is used through a provider interface with zod-validated structured outputs, a usage
ledger per tenant/user/feature/model, and a rule-based fallback so the CRM keeps working
when AI is disabled or unavailable. Natural-language reporting maps a question to one
**allowlisted report code** — the model never generates or executes SQL. AI output is never
written to authoritative fields without a person applying it.

## Raw payload retention

`portal_raw_payloads` and `webhook_receipts` keep request bodies with correlation ids,
response codes and normalized errors. Credentials and sensitive headers are redacted before
storage, and the retention job deletes rows past their `expires_at` (30 days by default).
