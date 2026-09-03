import { z } from 'zod';

export const idSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Invalid identifier');
export const optionalId = idSchema.nullish();
export const localeSchema = z.enum(['en', 'ar']);
export const currencySchema = z.string().length(3).toUpperCase();
export const countrySchema = z.string().length(2).toUpperCase();
export const emailSchema = z.string().email().max(190).toLowerCase();
export const phoneSchema = z.string().min(6).max(40);
export const moneySchema = z.coerce.number().min(0).max(9_999_999_999);
export const percentageSchema = z.coerce.number().min(0).max(100);
export const isoDate = z.coerce.date();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(25),
  cursor: z.string().max(400).optional(),
  sort: z.string().max(60).optional(),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export const searchSchema = paginationSchema.extend({
  q: z.string().max(200).optional(),
  include: z.string().max(200).optional(),
});

export const idempotencyHeaderSchema = z.object({
  'idempotency-key': z.string().min(8).max(190).optional(),
});

/** Strips undefined values so partial updates never overwrite columns with null. */
export function compact(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
