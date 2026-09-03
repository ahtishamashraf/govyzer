# Operations

## Logging

Structured JSON to stdout/stderr with a per-request `x-request-id` echoed to the client and
stored on audit rows. Anything resembling a credential is redacted at any nesting depth:
password, password_hash, authorization, cookie, refresh_token, access_token, token, api_key,
secret, ciphertext, credentials, code_verifier. Log level is `LOG_LEVEL`.

## Background work

Two engines share one queue table:

- **Outbox** (`outbox_events`) — domain events written in the same transaction as the change,
  drained into Sales Screen events, points, workflow runs and webhook deliveries.
- **Jobs** (`jobs`) — portal publication, SLA checks, reservation and hold expiry, workflow
  runs and resumes, document generation, AI enrichment, report delivery, exports, retention.

Both claim work with an atomic conditional update and a lease, respect a time budget and are
safe to run twice. Failures retry with exponential backoff up to `max_attempts`, then land in
`dead_letter_jobs` with the reason.

### Triage

```sql
-- queue depth by state
SELECT status, COUNT(*) FROM jobs GROUP BY status;

-- stuck outbox events
SELECT event_type, COUNT(*) FROM outbox_events WHERE status IN ('pending','processing') GROUP BY event_type;

-- what died and why
SELECT job_type, LEFT(last_error, 120) AS error, COUNT(*)
FROM dead_letter_jobs WHERE status = 'open' GROUP BY job_type, error;
```

Admins can see the same through `GET /v1/integrations/dead-letters` and requeue one with
`POST /v1/integrations/dead-letters/{id}/retry`.

## Rate limiting

Database-backed fixed windows (serverless instances share no memory). Applied to
authentication, display pairing, the display feed, public lead intake, feeds, webhooks, AI
and exports. Responses carry `x-ratelimit-limit`, `x-ratelimit-remaining`,
`x-ratelimit-reset` and, on rejection, `retry-after`.

## Backups and recovery

- Enable automated RDS backups with point-in-time recovery; test a restore quarterly.
- Restore into a new instance, run `npm run --workspace=@govyzer/database status` to confirm
  the schema matches the code, then repoint `DATABASE_HOST`.
- S3: enable versioning so an overwritten document can be recovered.

## Security operations

- **Sessions** — short-lived access tokens with rotating refresh sessions. Reusing a revoked
  refresh token revokes the whole family and is logged as `refresh_token_reuse`.
- **Credential rotation** — add a new `ENCRYPTION_KEYS` version, switch
  `ENCRYPTION_ACTIVE_KEY`, re-save connections, then drop the old key.
- **Display revocation** — `POST /v1/sales-screen/displays/{id}/revoke` invalidates every
  session immediately; the display returns to its pairing screen on the next poll.
- **Audit review** — `GET /v1/organization/audit-logs` filters by entity, action and date.
- **Data requests** — `data_exports` and `data_deletion_requests` carry the requester,
  approver and result; both need explicit permissions and are audited.

## Retention

The daily retention job deletes expired portal raw payloads, idempotency keys, rate-limit
buckets, long-expired sessions and used or expired tokens. Business history (audit, stage,
assignment, price, points, commission) is never deleted by the job.

## Monitoring checklist

| Signal | Where | Healthy |
| --- | --- | --- |
| API availability | `GET /health`, `GET /ready` | 200 |
| Job backlog | `jobs` where status in (queued, retry) | flat, drains each minute |
| Dead letters | `dead_letter_jobs` open | zero, investigated when not |
| Portal health | Integrations → Health | `healthy` per account |
| Display liveness | Sales Screen → Displays | Online, `last_seen_at` under two minutes |
| Webhook deliveries | `webhook_deliveries` pending/dead | pending drains, dead investigated |
| AI spend | `ai_usage_ledger` by period | within the tenant's expectation |

## Incident notes

- **Displays show stale data** — check `/v1/cron/outbox` and `/v1/cron/jobs` are firing; the
  display shows "Last updated N min ago" rather than pretending to be live.
- **Portal publishing fails for one account** — open Ready → Portal health; the exact field
  and message from the provider are listed with a Retry action.
- **A lead was not assigned** — open the lead's Assignment trail: every rule evaluated, every
  candidate considered and the reason are recorded. A lead is never dropped; the manager
  queue is the last resort.
