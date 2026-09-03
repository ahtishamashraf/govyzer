# Architecture

Govyzer is a modular monolith with three deployable applications sharing one database and
a set of internal packages. There are no microservices: modules are separated by clear
boundaries inside one API process, which keeps transactions simple while leaving room to
extract a module later.

```
apps/
  crm-web/      Next.js App Router CRM (browser + BFF proxy routes)
  api/          Express API, webhooks, cron handlers, job processors
  sales-screen/ Next.js display application (television/kiosk)
packages/
  config/       zod-validated environment, split into server and browser entry points
  database/     knex client, migrations, seeds, transaction helpers
  domain/       constants, state machines, policies, calculators (pure, no I/O)
  validation/   zod schemas shared by API and web forms
  integrations/ provider adapter contract, portal/messaging adapters, mapping engine
  ui/           shared JavaScript components and design tokens
```

## Request path

```
Browser → CRM BFF route (/api/bff/*) → API → middleware → controller → service → domain → repository → MySQL
```

Every API operation passes through the same chain:

1. **Security middleware** — helmet headers, a strict CORS allowlist, cookie parsing and
   double-submit CSRF for cookie-authorized writes.
2. **Authentication** — session cookie, bearer token, tenant API key or display token.
   `loadActorContext` assembles the actor: roles, permissions, module entitlements
   (intersected with the subscription plan) and record scope.
3. **Validation** — a zod schema per route; the parsed value replaces the raw input.
4. **Authorization** — `authorize(actor, permission)` checks the module entitlement first,
   then the permission. Record scope is applied to every list query.
5. **Service** — orchestrates a transaction, calls pure domain logic, writes through a
   repository that always requires an `organization_id`.
6. **Outbox** — domain events are written inside the same transaction as the change.

## Why a BFF proxy

Both web applications proxy API calls through their own origin (`/api/bff/*`). Session
cookies therefore stay first-party even when a tenant serves the CRM from its own custom
domain, so nothing depends on third-party cookie access. Server-only configuration such as
`API_INTERNAL_URL` never reaches the browser bundle.

## Multi-tenancy

- Every tenant-owned table carries `organization_id`, indexed, and unique indexes include
  it (`(organization_id, reference)`, `(organization_id, identifier_type, value_normalized)`).
- `createRepository()` refuses to build a query without an organization id — a missing
  tenant filter is a loud programming error, not a silent leak.
- Platform-level reference data (countries, communities, amenities, system roles) uses
  `organization_id = ''` so it can be shared without weakening tenant checks.
- Reference numbers are allocated from a per-tenant counter table under a row lock.

## Reliability patterns

| Concern | Mechanism |
| --- | --- |
| Event delivery | Transactional outbox (`outbox_events`) drained by a cron endpoint into Sales Screen events, points, workflow runs and webhook deliveries |
| Background work | MySQL job queue with atomic claim, lease, bounded batches, exponential retry and a dead-letter table |
| Inbound webhooks | Acknowledge fast, store the raw payload with a signature status, enqueue processing, deduplicate by provider event id |
| Inventory | `SELECT ... FOR UPDATE` plus a conditional status update, so a reservation only succeeds while the unit is still eligible |
| Concurrent edits | `version` columns with optimistic concurrency on leads, listings, deals, units, memberships and publications |
| Idempotency | `Idempotency-Key` header for creates; provider event ids for webhooks; dedupe keys for jobs |
| History | Soft deletes for ordinary records; append-only tables for audit, stage changes, assignment decisions, price history, points and commission snapshots |

## Serverless considerations

The API is one Express application exported through `apps/api/api/index.js`. Because every
warm instance holds its own connection pool, `DATABASE_POOL_MAX` defaults to 4 and cron
endpoints claim small batches with a time budget so an invocation always finishes inside
its limit. Running a batch twice is safe: the second run finds nothing left to claim.

## Extensibility

- **New country** — add a row to `countries`, its geography and portal adapters. Currency,
  timezone, locale, size unit and reference patterns are already per-organization.
- **New portal** — implement the adapter contract and call `registerPortalAdapter()`.
- **New module (for example property management)** — add migrations, a module constant, its
  permissions and a route group. Module entitlements and the navigation shell pick it up
  without touching existing modules.
