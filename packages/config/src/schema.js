import { z } from 'zod';

const bool = (defaultValue) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
    });

const int = (defaultValue) =>
  z
    .union([z.number(), z.string()])
    .default(defaultValue)
    .transform((value) => Number.parseInt(String(value), 10))
    .pipe(z.number().int());

const csv = (defaultValue = '') =>
  z
    .string()
    .default(defaultValue)
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    );

/**
 * Server-only environment contract. Never import this module from browser code.
 */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'preview', 'staging', 'production']).default('local'),
  PORT: int(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  // Database
  DATABASE_HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_PORT: int(3306),
  DATABASE_USER: z.string().min(1).default('govyzer'),
  DATABASE_PASSWORD: z.string().default(''),
  DATABASE_NAME: z.string().min(1).default('govyzer_dev'),
  DATABASE_SSL: bool(false),
  DATABASE_SSL_REJECT_UNAUTHORIZED: bool(true),
  DATABASE_SSL_CA: z.string().optional(),
  DATABASE_POOL_MIN: int(0),
  DATABASE_POOL_MAX: int(4),
  DATABASE_ACQUIRE_TIMEOUT_MS: int(15000),
  DATABASE_IDLE_TIMEOUT_MS: int(10000),
  DATABASE_DEBUG: bool(false),

  // Crypto / sessions
  ENCRYPTION_KEYS: z
    .string()
    .default('')
    .describe('Comma separated versioned keys, e.g. v1:<base64 32 bytes>,v2:<base64 32 bytes>'),
  ENCRYPTION_ACTIVE_KEY: z.string().default('v1'),
  JWT_ACCESS_SECRET: z.string().min(16).default('dev-only-access-secret-change-me'),
  JWT_ACCESS_TTL_SECONDS: int(900),
  REFRESH_TOKEN_TTL_DAYS: int(30),
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool(false),

  // URLs
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  CRM_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  SALES_SCREEN_PUBLIC_URL: z.string().url().default('http://localhost:3100'),
  ROOT_DOMAIN: z.string().default('localhost'),
  CORS_ALLOWED_ORIGINS: csv('http://localhost:3000,http://localhost:3100'),

  // Internal service auth + cron
  INTERNAL_API_TOKEN: z.string().default(''),
  CRON_SECRET: z.string().default(''),

  // S3
  S3_REGION: z.string().default('me-central-1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(false),
  S3_SIGNED_URL_TTL_SECONDS: int(900),
  S3_MAX_UPLOAD_BYTES: int(52428800),

  // Email
  MAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().default('no-reply@govyzer.local'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: bool(false),

  // OpenAI
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_MAX_OUTPUT_TOKENS: int(1200),
  AI_ENABLED: bool(true),

  // Messaging providers
  WHATSYNCS_BASE_URL: z.string().default(''),
  WHATSYNCS_API_KEY: z.string().default(''),
  WHATSYNCS_WEBHOOK_SECRET: z.string().default(''),
  WHATSAPP_CLOUD_BASE_URL: z.string().default('https://graph.facebook.com/v21.0'),
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_APP_SECRET: z.string().default(''),

  // OAuth providers
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),

  // Realtime (optional)
  REALTIME_PROVIDER: z.enum(['none', 'ably', 'pusher']).default('none'),
  REALTIME_KEY: z.string().default(''),

  // Observability
  SENTRY_DSN: z.string().default(''),

  // Limits
  RATE_LIMIT_WINDOW_MS: int(60000),
  RATE_LIMIT_MAX_REQUESTS: int(300),
  AUTH_RATE_LIMIT_MAX: int(20),

  // Sales screen
  DISPLAY_PAIRING_CODE_TTL_SECONDS: int(600),
  DISPLAY_SESSION_TTL_DAYS: int(180),
  DISPLAY_FEED_POLL_SECONDS: int(12),
});

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  NEXT_PUBLIC_APP_NAME: z.string().default('Govyzer'),
  NEXT_PUBLIC_DEFAULT_LOCALE: z.enum(['en', 'ar']).default('en'),
  NEXT_PUBLIC_DEFAULT_COUNTRY: z.string().default('AE'),
  NEXT_PUBLIC_DEFAULT_CURRENCY: z.string().default('AED'),
  NEXT_PUBLIC_DEFAULT_TIMEZONE: z.string().default('Asia/Dubai'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().default(''),
});
