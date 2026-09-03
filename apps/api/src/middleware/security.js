import cors from 'cors';
import helmet from 'helmet';
import { loadServerConfig } from '@govyzer/config';

/** Strict allowlist. Tenant custom domains are added through ORGANIZATION domains + env. */
export function corsMiddleware(extraOrigins = []) {
  const { env } = loadServerConfig();
  const allowed = new Set([...env.CORS_ALLOWED_ORIGINS, ...extraOrigins]);

  return cors({
    origin(origin, callback) {
      // Same-origin/server-to-server requests send no Origin header.
      if (!origin) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      try {
        const host = new URL(origin).hostname;
        if (env.ROOT_DOMAIN && (host === env.ROOT_DOMAIN || host.endsWith(`.${env.ROOT_DOMAIN}`))) {
          return callback(null, true);
        }
      } catch {
        /* fall through to rejection */
      }
      return callback(new Error(`Origin ${origin} is not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-api-key',
      'x-csrf-token',
      'x-request-id',
      'idempotency-key',
      'x-display-token',
      'x-organization-id',
      'if-none-match',
    ],
    exposedHeaders: ['x-request-id', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'etag', 'retry-after'],
    maxAge: 600,
  });
}

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
  });
}
