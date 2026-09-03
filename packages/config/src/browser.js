import { publicEnvSchema } from './schema.js';

/**
 * Browser-safe configuration. Only NEXT_PUBLIC_* values are ever read here so that no
 * server secret can be inlined into a client bundle.
 */
export function readPublicConfig(source = {}) {
  const parsed = publicEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid public configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ')}`
    );
  }
  return parsed.data;
}

export const DEFAULT_TENANT_DEFAULTS = Object.freeze({
  locale: 'en',
  country: 'AE',
  currency: 'AED',
  timezone: 'Asia/Dubai',
  dateFormat: 'dd/MM/yyyy',
});
