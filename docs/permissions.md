# Permissions

Authorization has three independent layers. All three must pass.

1. **Module entitlement** — the membership's modules intersected with the subscription
   plan's modules. A user can hold Ready only, Off-plan only, Sales Screen administration
   only, or any combination.
2. **Permission** — a `resource.action` code checked by `authorize(actor, permission)` on
   every protected route.
3. **Record scope** — how much of the permitted resource the person sees.

```
authorize(actor, 'leads.read')
  ├─ platform admin?            → allow
  ├─ module for this permission enabled for the membership? → else 403 "module is not enabled"
  └─ permission held by any of the membership roles?         → else 403 "Missing permission"
```

## Record scopes

| Scope | Sees |
| --- | --- |
| `own` | Records they created |
| `assigned` | Records assigned to them, plus their own |
| `team` | Their team's records, plus assigned and own |
| `branch` | Every record in their branch |
| `organization` | Every record in the organization |

`applyRecordScope()` adds the predicate to every list query. When a membership holds
several roles, the widest scope wins (`effectiveScope`).

## Default roles

| Role | Scope | Modules | Intent |
| --- | --- | --- | --- |
| `org_owner` | organization | all | Full control including billing |
| `org_admin` | organization | all | Everything except billing |
| `branch_manager` | branch | ready, offplan, sales_screen | Runs a branch, approves listings, assigns leads |
| `sales_manager` | team | ready, offplan, sales_screen | Runs a team, approves and reassigns |
| `team_leader` | team | ready, offplan | Leads a team, can assign and approve listings |
| `agent` | assigned | ready | Works their own leads, listings and deals |
| `offplan_agent` | assigned | offplan | Off-plan equivalent |
| `listing_admin` | organization | ready | Owns listing quality and portal publication |
| `offplan_admin` | organization | offplan | Owns projects, stock, prices and payment plans |
| `finance` | organization | finance, ready, offplan | Invoices, payments, commission approval |
| `compliance` | organization | ready, offplan, admin | Approvals, documents, audit, data requests |
| `marketing` | organization | ready, offplan | Read-only marketing view plus AI copy |
| `sales_screen_admin` | organization | sales_screen | Displays, playlists, points, targets |
| `read_only` | organization | ready, offplan | View only |

Tenants create custom roles from the same permission catalogue
(`GET /v1/organization/permissions`). System roles cannot be edited; duplicate one instead.

## Permission catalogue

Codes are grouped by module: `organization.*`, `users.*`, `roles.*`, `audit.read`,
`custom_fields.manage`, `api_keys.manage`, `data.export`, `data.delete`, `contacts.*`,
`leads.*`, `activities.*`, `communications.*`, `listings.*`, `portals.*`, `developers.*`,
`projects.*`, `units.*`, `prices.manage`, `holds.*`, `reservations.*`, `bookings.manage`,
`deals.*`, `documents.*`, `invoices.*`, `commissions.*`, `workflows.*`, `integrations.*`,
`webhooks.manage`, `ai.*`, `reports.*`, `sales_screen.*`.

The live list, with module and description, is served by the API and rendered in
Settings → Roles.

## Field-level protection

Some fields are removed from responses unless the actor holds a specific permission:

| Entity | Field | Requires |
| --- | --- | --- |
| Contact identifier | `value_raw`, `value_normalized` | `contacts.view_sensitive` (otherwise masked, e.g. `om***@example.ae`, `••••4567`) |
| Deal | `gross_commission`, `net_commission`, `commission_percentage` | `commissions.read` |
| Integration connection | credentials | `integrations.manage` (ciphertext is never returned at all) |

Agents see their own commission lines through `commissions.read_own`; the full ledger needs
`commissions.read`.

## Non-employee credentials

| Credential | Carries | Can reach |
| --- | --- | --- |
| **Tenant API key** (`x-api-key`) | Explicit scopes, one organization | Only endpoints whose permission is in its scopes; used by Zapier and websites |
| **Display token** (`x-display-token`) | One display, one organization | Only `GET /v1/display/feed` and `POST /v1/display/heartbeat`. It is rejected on every CRM route |
| **Cron secret** (`x-cron-secret`) | No tenant | Only `/v1/cron/*` |

## Audit

Every state-changing operation appends to `audit_logs` with actor, organization, action,
entity, a redacted before/after diff, request id, IP, user agent and source. Audit rows are
never updated or deleted, and secrets are stripped by the same redaction used for logs.
