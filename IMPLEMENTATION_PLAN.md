# Govyzer — Implementation Plan

Multi-tenant UAE real-estate SaaS: CRM (Ready + Off-plan), API, and a separate Sales Screen
display application. JavaScript only (no TypeScript), npm workspaces monorepo, Next.js App
Router + Express + Knex/MySQL 8 + S3, deployable as three independent Vercel projects.

## Milestones

### M1 — Foundation
- [x] Monorepo, npm workspaces, lint/format/test tooling, no-TypeScript guard
- [x] `packages/config` — zod-validated environment/runtime configuration (server + browser split)
- [x] `packages/database` — knex client, serverless-safe pool, migration/seed runner, tx helpers
- [x] `packages/validation` — shared zod schemas
- [x] `packages/domain` — constants, state machines, policies, calculators
- [x] Core schema migrations (platform, access, CRM, inventory, listings, off-plan, deals,
      finance, integrations, jobs, AI, sales screen)

### M2 — Security foundation
- [x] Password hashing (bcryptjs), access/refresh tokens, rotating sessions, HTTP-only cookies
- [x] CSRF protection, CORS allowlist, secure headers, rate limiting
- [x] AES-256-GCM credential encryption with key versioning
- [x] RBAC: roles, permissions, module entitlements, record scopes, field-level protection
- [x] Append-only audit logs, request IDs, structured logging with redaction

### M3 — API core
- [x] Express modular app (controller → service → domain → repository)
- [x] Auth, organizations, branding, domains, users/memberships/roles
- [x] Contacts (multi-role, multi-lead), leads, requirements, assignment engine, lead pool, SLA
- [x] Activities: notes, tasks, meetings, viewings, offers, communication timeline
- [x] Ready listings: versions, approvals, permits, media, price/availability history
- [x] Portal framework: providers, accounts, field mappings, publications, sync jobs, feeds
- [x] Off-plan: developers, projects, phases, buildings, unit types, units, price lists,
      payment plans, stock import, holds, reservations (atomic), bookings
- [x] Deals, parties, stage history, approvals, documents, invoices, payments, receipts
- [x] Commission plans/rules/snapshots/lines, 50/50 default, overrides, validation
- [x] Workflows (versioned, loop-protected), outbox, jobs, cron endpoints
- [x] AI features via OpenAI provider interface with zod structured outputs + usage ledger
- [x] Sales displays: pairing, scoped sessions, feed, heartbeat, events, points, targets
- [x] Dashboards, reports, exports
- [x] Data export and deletion requests with approval, anonymization and audit trail
- [x] OpenAPI 3.1 document validated against the router table

### M4 — CRM web
- [x] Tenant-branded auth/onboarding, BFF proxy routes (same-origin cookies)
- [x] Module switcher shell, i18n EN/AR + RTL, PWA manifest/service worker
- [x] Executive / Ready / Off-plan / Sales Screen dashboards
- [x] Leads (table + kanban), contacts, listings wizard, inventory matrix, deals, calendar,
      communications, documents, reports, automations, integrations, settings
- [x] Command palette, global search, saved views, exports, permission-aware UI

### M5 — Sales Screen app
- [x] Pairing screen (code + QR), display-scoped session storage, heartbeats
- [x] Playlist renderer, widgets, themes, offline/stale state, PWA

### M6 — Quality
- [x] Seeds (platform admin + two demo orgs)
- [x] Unit, integration (MySQL), API (supertest), security regression, E2E (Playwright)
- [x] Docs: architecture, data model, permissions, integrations, deployment, operations, flows
- [x] Lint + build green
- [x] CI workflow: guards, lint, migrations, tests, OpenAPI drift check, production builds

## Status

All milestones are complete. `STATUS.md` carries the latest verification results, the
known limitations (notably: TOTP MFA is not implemented) and the remaining external
blockers, which are credentials and accounts rather than code.

## Checklist conventions
Items are only checked when the code exists, is wired to real queries/UI, and has a test or a
documented manual verification path.
