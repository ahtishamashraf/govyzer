# Govyzer

A multi-tenant real-estate SaaS platform for UAE brokerages and developers, built as three
independently deployable applications from one monorepo:

| Application | Path | What it is |
| --- | --- | --- |
| **CRM** | `apps/crm-web` | Next.js App Router CRM: Ready listings, Off-plan inventory, leads, deals, reports, automations, integrations and Sales Screen administration |
| **API** | `apps/api` | Express API, webhooks, cron handlers, integrations and job processors — runs locally and as Vercel Functions |
| **Sales Screen** | `apps/sales-screen` | Separate Next.js display application for office televisions, paired with a one-time code |

JavaScript only — no TypeScript sources, configs or dependencies (enforced by
`npm run check:no-typescript`).

## What it does

- **Multi-tenancy** — every business table carries `organization_id`; roles, module
  entitlements and record scopes decide what each person sees. A security regression suite
  proves one tenant cannot reach another's data by id, search, count, export, nested route
  or display feed.
- **Ready module** — listings with versions, approvals, permits, media, portal validation
  and per-portal publication status, plus an errors screen showing the exact rejected field.
- **Off-plan module** — developers, projects, phases, unit types, bulk stock import,
  inventory matrix, price lists, payment plans, expiring holds and **atomic** reservations
  that cannot double book.
- **Leads** — capture from portals, website, Zapier, WhatsApp and manual entry; contact
  deduplication that never discards a repeat enquiry; an explained assignment engine;
  configurable SLA escalation and a concurrency-safe lead pool.
- **Deals and commission** — configurable split plans (50/50 by default) with tiers, caps,
  fixed lines and referral partners; the split is snapshotted immutably when the deal is
  won and reversed cleanly when it is cancelled.
- **Sales Screen** — displays paired with a hashed, single-use code receive a scoped,
  revocable session that can only read an approved, PII-free feed.
- **Automation, integrations and AI** — versioned workflows with loop protection, a
  provider-adapter framework for portals and messaging, and OpenAI features with structured
  outputs, a usage ledger and full functionality when AI is switched off.

## Quick start

```bash
# 1. Start MySQL (Docker optional — any local MySQL 8 works)
docker compose up -d mysql

# 2. Install and configure
npm install
cp apps/api/.env.example .env                  # the API reads .env from the repo root
node -e "console.log('ENCRYPTION_KEYS=v1:'+require('crypto').randomBytes(32).toString('base64'))"

# 3. Create the schema and seed
npm run db:migrate
npm run db:seed          # UAE reference data (cities, communities, amenities)
npm run db:seed:demo     # development-only demo tenants; prints credentials

# 4. Run everything
npm run dev              # API :4000, CRM :3000, Sales Screen :3100
```

The demo seed prints two unrelated organizations plus a platform administrator. It refuses
to run when `APP_ENV=production`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the API, CRM and Sales Screen together |
| `npm run build` | Production builds for both Next.js applications |
| `npm run db:migrate` / `db:rollback` / `db:seed` / `db:reset` | Schema and seed management |
| `npm run db:seed:demo` | Development demo data (two tenants) |
| `npm test` | Unit, integration, API and OpenAPI suites (needs MySQL) |
| `npm run test:e2e` | Playwright end-to-end suite across all three applications |
| `npm run lint` | ESLint across the monorepo |
| `npm run check:no-typescript` | Fails if TypeScript appears anywhere |
| `npm run check:placeholders` | Fails on TODO markers, dead handlers and `alert()` UX |
| `npm run openapi --workspace=@govyzer/api` | Regenerates `docs/api/openapi.yaml` from the live routes |

## Documentation

- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [Permissions](docs/permissions.md)
- [Integrations](docs/integrations.md)
- [Deployment](docs/deployment.md)
- [Operations](docs/operations.md)
- [User flows](docs/user-flows.md)
- [OpenAPI 3.1](docs/api/openapi.yaml)
