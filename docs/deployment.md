# Deployment

Three Vercel projects from one repository, one MySQL 8 database on AWS RDS and one private
S3 bucket.

## Vercel projects

| Project | Root directory | Framework | Build command |
| --- | --- | --- | --- |
| `govyzer-api` | `apps/api` | Other | `echo "No build step"` (runs as a Node Function) |
| `govyzer-crm` | `apps/crm-web` | Next.js | `npm run build --workspace=@govyzer/crm-web` |
| `govyzer-sales-screen` | `apps/sales-screen` | Next.js | `npm run build --workspace=@govyzer/sales-screen` |

Each application has its own `vercel.json`. Set the install command to
`npm install --workspaces --include-workspace-root` so workspace packages resolve.

The API is exported from `apps/api/api/index.js`; `vercel.json` rewrites every path to it
and declares the cron schedule. Node.js runtime: 22.x (`engines` in the root
`package.json`).

## Environment variables

Copy from `apps/api/.env.example`, `apps/crm-web/.env.example` and
`apps/sales-screen/.env.example`. Values that must be set for a production deployment
(the API refuses to boot without them when `APP_ENV=production`):

`JWT_ACCESS_SECRET`, `ENCRYPTION_KEYS`, `CRON_SECRET`, `INTERNAL_API_TOKEN`, `S3_BUCKET`,
`DATABASE_SSL=true`, `COOKIE_SECURE=true`.

Generate an encryption key:

```bash
node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"
```

Key rotation: add `v2:<key>` to `ENCRYPTION_KEYS`, set `ENCRYPTION_ACTIVE_KEY=v2` and keep
`v1` present until stored credentials have been re-saved. Ciphertext records their key
version, so both can be decrypted during the overlap.

The web projects need `API_INTERNAL_URL` (server-only, used by the BFF proxy) and the
`NEXT_PUBLIC_*` values. `API_INTERNAL_URL` must not be exposed as a `NEXT_PUBLIC_` variable.

## AWS RDS (MySQL 8)

1. Create a MySQL 8.0 instance, **not publicly accessible**, in a private subnet.
2. Create the database and an application user:

   ```sql
   CREATE DATABASE govyzer CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'govyzer'@'%' IDENTIFIED BY '<strong password>';
   GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP ON govyzer.* TO 'govyzer'@'%';
   ```

3. Enforce TLS on the instance (`require_secure_transport=ON`) and set `DATABASE_SSL=true`.
   To pin the certificate, download the regional RDS CA bundle and put its contents in
   `DATABASE_SSL_CA` (escape newlines as `\n`).
4. **Connectivity from Vercel.** Do not open port 3306 to the internet. Use Vercel Secure
   Compute so functions get static outbound IPs inside a VPC peered with your RDS VPC, and
   allow only those IPs in the RDS security group. If Secure Compute is not available on
   your plan, put the database behind a private connection such as a VPN or an AWS PrivateLink
   endpoint reachable only by your functions. A publicly reachable database is not a
   supported configuration.
5. Keep `DATABASE_POOL_MAX` small (4 by default). Every warm function instance holds a pool;
   `max_connections` on the instance must exceed `instances × pool_max` with headroom.

## Database migrations

Migrations are **never** run automatically on a cold start. Run them as an explicit,
reviewed step:

```bash
# from a machine or CI job with network access to RDS
DATABASE_HOST=... DATABASE_USER=... DATABASE_PASSWORD=... DATABASE_NAME=govyzer \
DATABASE_SSL=true APP_ENV=production \
npm run db:migrate

npm run --workspace=@govyzer/database status   # verify nothing is pending
```

Roll back one batch with `npm run db:rollback`. `db:reset` and `db:seed:demo` refuse to run
when `APP_ENV=production`.

## S3

1. Create a private bucket in your region (for example `me-central-1`). Block all public
   access; there is no public object policy.
2. CORS — allow only your CRM origins for presigned uploads:

   ```json
   [
     {
       "AllowedOrigins": ["https://crm.example.com", "https://*.govyzer.app"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["content-type", "x-amz-*"],
       "ExposeHeaders": ["etag"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```

3. Lifecycle — expire `tenants/*/export/*` after 30 days and abort incomplete multipart
   uploads after 7 days.
4. IAM — the application user needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and
   `s3:HeadObject` on `arn:aws:s3:::<bucket>/tenants/*` only.
5. Objects are written under `tenants/{organization_id}/{entity}/{id}/...` and always served
   through short-lived presigned URLs.

## Cron

`apps/api/vercel.json` declares the schedule. Vercel calls each path with the project's cron
authorization; the endpoints additionally require `CRON_SECRET` through the `authorization`
bearer or `x-cron-secret` header, so configure that secret on the cron requests.

| Path | Schedule | Work |
| --- | --- | --- |
| `/v1/cron/outbox` | every minute | Publish domain events |
| `/v1/cron/jobs` | every minute | Run one bounded job batch |
| `/v1/cron/sla` | every 5 minutes | Sweep due SLA timers |
| `/v1/cron/expiries` | every 10 minutes | Expire reservations and holds |
| `/v1/cron/webhooks` | every 5 minutes | Retry deliveries and unprocessed receipts |
| `/v1/cron/portals` | hourly | Refresh publication status, retry stalled publishes |
| `/v1/cron/workflows` | every 5 minutes | Resume waiting workflow runs |
| `/v1/cron/reminders` | every 15 minutes | Meeting and task reminders |
| `/v1/cron/reports` | daily 06:00 | Scheduled report delivery |
| `/v1/cron/retention` | daily 03:00 | Retention and expired token cleanup |

## Custom domains

Every tenant gets `{slug}.govyzer.app`. For a custom domain the tenant adds it in Settings →
Domains, publishes the `_govyzer.<host>` TXT record shown, and presses Verify. Point the
domain at the CRM Vercel project as a wildcard or explicit domain. No per-tenant deployment
is required: the CRM proxies API calls through its own origin, so cookies stay first-party.

## Health checks

`GET /health` (liveness), `GET /ready` (database reachable), `GET /version` (build and
commit), `GET /v1/integrations/health` (per-tenant connection health, authenticated).
