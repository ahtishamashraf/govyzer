# User flows

Each flow below is exercised by the automated suites; the test that covers it is named.

## 1. Company onboarding

1. The owner registers at `/register` with company name, workspace address, their details
   and the modules they want.
2. The API creates the organization and, in the same transaction, provisions: branding, a
   subscription, a `{slug}.govyzer.app` domain, a head-office branch, both lead pipelines
   with the eleven default stages, twelve lead sources, SLA rules per module, the 50/50
   commission plan, points rules, a default Sales Screen playlist with eight slides and nine
   clearly labelled sample document templates.
3. The owner receives an email verification link and lands on the executive dashboard.
4. Settings → Organization sets UAE defaults (AED, Asia/Dubai, VAT, reference prefix,
   commission base); Branding sets colours, fonts and the Sales Screen theme.
5. Settings → People invites colleagues with a role, modules and record scope. An invitation
   is a single-use hashed token; accepting it creates the membership and the session.
6. Integrations connects portals and channels; Off-plan imports stock; the dashboards are
   populated from real data from that point on.

_Covered by:_ `tests/e2e/onboarding.spec.js`, `tests/api/auth.test.js`.

## 2. Ready portal lead

1. A listing is created through the four-step wizard (property, pricing, marketing,
   compliance) with autosave, then submitted and approved.
2. Publishing runs portal validation first. Failures are returned per portal with the exact
   field: `permit_required`, `description_too_short`, `images_required`, `agent_required`,
   `community_required`. Only valid listings queue.
3. Each portal publication carries its own status and error history. The feed URL is given to
   portals that pull; portals that push receive the payload through the adapter.
4. A portal lead arrives at `/v1/webhooks/portal/{provider}/{token}`. The raw payload is
   stored with its signature status and acknowledged immediately.
5. The job runner normalizes it: the contact is deduplicated by phone or email, a **new**
   lead and requirement are created (a repeat number never discards the enquiry), and the
   lead is linked to the referenced listing.
6. The assignment engine routes it to the listing's eligible primary agent; if that agent is
   inactive, over capacity or outside working hours it uses the listing fallback, then tenant
   rules, then the responsible manager queue. Every evaluated rule and candidate is recorded.
7. SLA timers start: acknowledge at 5 minutes, manager alert at 15, pool release at 30 — all
   tenant editable. Agent and manager are notified.
8. Viewings, offers and a deal can be created from the lead; the whole timeline stays on the
   contact.

_Covered by:_ `tests/api/flows.test.js` (webhook intake, validation, feed),
`tests/integration/crm-flows.test.js` (dedupe, SLA escalation).

## 3. Off-plan lead and reservation

1. Off-plan admin creates the developer and project, adds unit types and a payment plan, and
   imports stock from the CSV template. The import previews first: valid rows, error rows
   with the exact field, duplicate detection, and idempotent re-import by key.
2. The project's assignment policy (specialist, round robin, least workload, manager inbox…)
   decides who owns off-plan enquiries for it.
3. An enquiry arrives and is routed by that policy. The agent records meetings and follow-ups.
4. Matching filters available units by hard requirements (type, bedrooms, budget, size,
   community, handover) and ranks what qualifies.
5. The agent places a **hold** with an expiry. Only one active hold can exist per unit.
6. Reservation acquires the unit atomically: the row is locked and the status flips only
   while the unit is still eligible. A second agent reserving the same unit at the same
   moment receives `409` — double booking is impossible.
7. The payment schedule is produced from the plan; reservation, booking and SPA documents are
   generated as PDFs from tenant-approved templates.
8. Unpaid or unconverted reservations expire automatically and release the unit; the agent is
   notified.

_Covered by:_ `tests/integration/crm-flows.test.js` (import, concurrency, expiry),
`tests/api/flows.test.js`.

## 4. Deal and commission

1. A deal is created from a lead, listing, unit or reservation with its parties.
2. The economics are validated: a gross commission is required before a deal can be won.
3. Documents are generated and tracked through their signature status.
4. The commission plan is resolved by scope specificity (membership → team → branch/project →
   source/deal type → organization) then priority.
5. Winning the deal writes an **immutable snapshot**: the rules, the inputs and the
   calculated lines. Percentage splits must total 100%, fixed lines and tiers are supported,
   and rounding residue settles on the company line so the split always balances to the cent.
   Editing the plan afterwards does not change the snapshot.
6. Winning also emits `deal.won`, which produces revenue in reporting, a points ledger entry
   and — subject to tenant approval settings — a Sales Screen celebration.
7. Cancelling writes a reversing snapshot and negative points entries, so nothing has to be
   deleted to correct the record.

_Covered by:_ `tests/integration/crm-flows.test.js` (snapshot immutability, reversal),
`tests/unit/domain.test.js` (splits, tiers, validation).

## 5. Sales Screen pairing and display

1. An authorized admin creates a display in the CRM and generates a pairing code. The code is
   random, hashed at rest, single use, rate limited and expires in minutes.
2. The Sales Screen application asks for the code (or opens the pairing URL with it
   pre-filled) and exchanges it for a display-scoped session.
3. That token can read only its own approved feed and post heartbeats. It is rejected on
   every CRM route.
4. The CRM shows linked, online/offline, last seen, app version and revoked state.
5. The display polls with an ETag every ~12 seconds with backoff and visibility awareness,
   caches the last good feed and shows "Last updated N min ago" instead of pretending to be
   live.
6. Winning a deal or publishing a listing produces an event that appears on the wall,
   immediately or after approval depending on tenant settings. Points and leaderboards are
   recomputed from the ledger, never from a mutable total.
7. Revoking the display invalidates every session at once; the wall returns to the pairing
   screen on its next poll.
8. Client names, phone numbers, emails, private notes and exact addresses are never sent to a
   display; amounts and agent names can additionally be masked per display.

_Covered by:_ `tests/e2e/onboarding.spec.js` (pairing, live render, revocation),
`tests/api/security.test.js` (scope, reuse, PII).
