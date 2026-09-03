import { z } from 'zod';
import { emailSchema, idSchema, localeSchema } from './common.js';

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200)
  .refine((value) => /[a-z]/.test(value), 'Password must contain a lowercase letter')
  .refine((value) => /[A-Z]/.test(value), 'Password must contain an uppercase letter')
  .refine((value) => /\d/.test(value), 'Password must contain a digit')
  .refine((value) => /[^A-Za-z0-9]/.test(value), 'Password must contain a symbol');

export const registerSchema = z.object({
  organization_name: z.string().min(2).max(180),
  organization_slug: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, numbers and hyphens'),
  first_name: z.string().min(1).max(80),
  last_name: z.string().min(1).max(80),
  email: emailSchema,
  password: passwordSchema,
  phone: z.string().max(40).optional(),
  locale: localeSchema.default('en'),
  country: z.string().length(2).default('AE'),
  timezone: z.string().max(64).default('Asia/Dubai'),
  currency: z.string().length(3).default('AED'),
  modules: z.array(z.enum(['ready', 'offplan', 'sales_screen'])).min(1).default(['ready']),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  organization_id: idSchema.optional(),
  mfa_code: z.string().length(6).optional(),
});

export const refreshSchema = z.object({ refresh_token: z.string().min(10).optional() });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(400),
  password: passwordSchema,
});

export const verifyEmailSchema = z.object({ token: z.string().min(10).max(400) });

export const inviteSchema = z.object({
  email: emailSchema,
  role_codes: z.array(z.string().max(60)).min(1),
  modules: z.array(z.enum(['ready', 'offplan', 'sales_screen', 'finance', 'admin'])).default(['ready']),
  branch_id: idSchema.optional(),
  team_id: idSchema.optional(),
  job_title: z.string().max(120).optional(),
  record_scope: z.enum(['own', 'assigned', 'team', 'branch', 'organization']).default('assigned'),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(10).max(400),
  first_name: z.string().min(1).max(80).optional(),
  last_name: z.string().min(1).max(80).optional(),
  password: passwordSchema.optional(),
});

export const switchOrganizationSchema = z.object({ organization_id: idSchema });

export const enableMfaSchema = z.object({ code: z.string().length(6) });
