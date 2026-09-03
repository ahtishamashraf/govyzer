import { z } from 'zod';
import {
  DEAL_TYPES,
  DEAL_PARTY_ROLES,
  COMMISSION_RECIPIENT_TYPES,
  COMMISSION_BASES,
  WORKFLOW_TRIGGERS,
  WORKFLOW_ACTIONS,
  AI_FEATURES,
  DISPLAY_SLIDE_TYPES,
  SALES_EVENT_TYPES,
} from '@govyzer/domain/constants';
import { idSchema, moneySchema, percentageSchema, searchSchema, emailSchema } from './common.js';

export const dealSchema = z.object({
  deal_type: z.enum(DEAL_TYPES).default('ready_sale'),
  module: z.enum(['ready', 'offplan']).default('ready'),
  lead_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  listing_id: idSchema.optional(),
  unit_id: idSchema.optional(),
  project_id: idSchema.optional(),
  reservation_id: idSchema.optional(),
  agent_membership_id: idSchema.optional(),
  manager_membership_id: idSchema.optional(),
  property_value: moneySchema.optional(),
  gross_commission: moneySchema.optional(),
  commission_percentage: percentageSchema.optional(),
  currency: z.string().length(3).default('AED'),
  rent_frequency: z.enum(['yearly', 'monthly', 'weekly', 'daily']).optional(),
  contract_date: z.coerce.date().optional(),
  handover_date: z.coerce.date().optional(),
  expected_close_date: z.coerce.date().optional(),
  commission_plan_id: idSchema.optional(),
  parties: z
    .array(
      z.object({
        party_role: z.enum(DEAL_PARTY_ROLES),
        party_type: z.enum(['contact', 'membership', 'developer', 'company']).default('contact'),
        contact_id: idSchema.optional(),
        membership_id: idSchema.optional(),
        developer_id: idSchema.optional(),
        company_name: z.string().max(180).optional(),
        share_percentage: percentageSchema.optional(),
      })
    )
    .default([]),
  version: z.coerce.number().int().optional(),
});

export const dealStageSchema = z.object({
  stage: z.enum(['draft', 'documentation', 'approval', 'signed', 'won', 'lost', 'cancelled']),
  reason: z.string().max(300).optional(),
});

export const dealSearchSchema = searchSchema.extend({
  status: z.string().max(24).optional(),
  stage: z.string().max(30).optional(),
  deal_type: z.enum(DEAL_TYPES).optional(),
  module: z.enum(['ready', 'offplan']).optional(),
  agent_membership_id: idSchema.optional(),
  won_from: z.coerce.date().optional(),
  won_to: z.coerce.date().optional(),
});

export const offerSchema = z.object({
  lead_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  listing_id: idSchema.optional(),
  unit_id: idSchema.optional(),
  deal_id: idSchema.optional(),
  offer_type: z.enum(['purchase', 'rental']).default('purchase'),
  amount: moneySchema,
  currency: z.string().length(3).default('AED'),
  rent_frequency: z.enum(['yearly', 'monthly', 'weekly', 'daily']).optional(),
  cheques: z.coerce.number().int().min(1).max(12).optional(),
  valid_until: z.coerce.date().optional(),
  conditions: z.string().max(4000).optional(),
});

export const commissionPlanSchema = z.object({
  name: z.string().min(1).max(160),
  code: z.string().min(1).max(60),
  description: z.string().max(4000).optional(),
  commission_base: z.enum(COMMISSION_BASES).default('gross_before_vat'),
  is_default: z.boolean().default(false),
  effective_from: z.coerce.date().optional(),
  effective_to: z.coerce.date().optional(),
  rules: z
    .array(
      z.object({
        position: z.coerce.number().int().min(1),
        recipient_type: z.enum(COMMISSION_RECIPIENT_TYPES),
        recipient_ref: idSchema.optional(),
        label: z.string().max(160).optional(),
        calculation_type: z.enum(['percentage', 'fixed']).default('percentage'),
        percentage: percentageSchema.optional(),
        fixed_amount: moneySchema.optional(),
        applies_to: z.enum(['gross', 'remaining']).default('gross'),
        conditions: z.record(z.string(), z.unknown()).optional(),
        tiers: z
          .array(z.object({ from: moneySchema, to: moneySchema.optional(), percentage: percentageSchema }))
          .optional(),
        cap_amount: moneySchema.optional(),
        requires_approval: z.boolean().default(false),
      })
    )
    .min(1),
  assignments: z
    .array(
      z.object({
        scope_type: z.enum(['organization', 'branch', 'team', 'membership', 'role', 'deal_type', 'source', 'project']),
        scope_id: idSchema.optional(),
        deal_type: z.enum(DEAL_TYPES).optional(),
        project_id: idSchema.optional(),
        priority: z.coerce.number().int().min(1).max(1000).default(100),
        effective_from: z.coerce.date().optional(),
        effective_to: z.coerce.date().optional(),
      })
    )
    .default([]),
});

export const commissionCalculateSchema = z.object({
  commission_plan_id: idSchema.optional(),
  gross_commission: moneySchema.optional(),
  manual_overrides: z
    .array(
      z.object({
        recipient_type: z.enum(COMMISSION_RECIPIENT_TYPES),
        membership_id: idSchema.optional(),
        contact_id: idSchema.optional(),
        amount: moneySchema,
        reason: z.string().max(300),
        label: z.string().max(160).optional(),
      })
    )
    .default([]),
});

export const documentTemplateSchema = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(180),
  category: z.string().max(40).default('general'),
  document_type: z.string().min(1).max(60),
  language: z.enum(['en', 'ar']).default('en'),
  requires_approval: z.boolean().default(true),
  body_html: z.string().max(500_000).optional(),
  variables: z.array(z.object({ key: z.string().max(60), label: z.string().max(160), required: z.boolean().default(false) })).default([]),
  conditional_sections: z.record(z.string(), z.unknown()).optional(),
  change_note: z.string().max(500).optional(),
});

export const documentGenerateSchema = z.object({
  template_id: idSchema,
  entity_type: z.enum(['deal', 'reservation', 'booking', 'listing', 'invoice', 'payment', 'lead', 'unit']),
  entity_id: idSchema,
  language: z.enum(['en', 'ar']).default('en'),
  variables: z.record(z.string(), z.unknown()).optional(),
});

export const invoiceSchema = z.object({
  deal_id: idSchema.optional(),
  booking_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  invoice_type: z.enum(['commission', 'reservation', 'installment', 'service', 'other']).default('commission'),
  issue_date: z.coerce.date(),
  due_date: z.coerce.date().optional(),
  currency: z.string().length(3).default('AED'),
  trn: z.string().max(40).optional(),
  notes: z.string().max(4000).optional(),
  items: z
    .array(
      z.object({
        description: z.string().min(1).max(400),
        quantity: z.coerce.number().min(0.001).default(1),
        unit_price: moneySchema,
        vat_percentage: percentageSchema.default(5),
      })
    )
    .min(1),
});

export const paymentSchema = z.object({
  deal_id: idSchema.optional(),
  booking_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  invoice_id: idSchema.optional(),
  payment_type: z.enum(['commission', 'reservation', 'installment', 'deposit', 'other']).default('commission'),
  direction: z.enum(['inbound', 'outbound']).default('inbound'),
  method: z.enum(['bank_transfer', 'cheque', 'cash', 'card', 'online']).default('bank_transfer'),
  amount: moneySchema,
  currency: z.string().length(3).default('AED'),
  paid_on: z.coerce.date(),
  cheque_number: z.string().max(60).optional(),
  cheque_due_on: z.coerce.date().optional(),
  bank_name: z.string().max(120).optional(),
  transaction_reference: z.string().max(120).optional(),
  notes: z.string().max(4000).optional(),
});

export const workflowSchema = z.object({
  name: z.string().min(1).max(180),
  code: z.string().min(1).max(60),
  description: z.string().max(4000).optional(),
  trigger_type: z.enum(WORKFLOW_TRIGGERS),
  entity_type: z.string().max(40).optional(),
  trigger_config: z.record(z.string(), z.unknown()).default({}),
  conditions: z.array(z.record(z.string(), z.unknown())).default([]),
  actions: z
    .array(
      z.object({
        position: z.coerce.number().int().min(1),
        action_type: z.enum(WORKFLOW_ACTIONS),
        config: z.record(z.string(), z.unknown()).default({}),
      })
    )
    .min(1),
  max_runs_per_entity_per_day: z.coerce.number().int().min(1).max(500).default(20),
  change_note: z.string().max(500).optional(),
});

export const workflowTestSchema = z.object({
  sample: z.record(z.string(), z.unknown()),
  entity_type: z.string().max(40).optional(),
});

export const integrationConnectionSchema = z.object({
  provider: z.string().min(1).max(60),
  category: z.enum(['portal', 'messaging', 'email', 'calendar', 'telephony', 'automation', 'signature', 'ai']).default('portal'),
  name: z.string().min(1).max(160),
  settings: z.record(z.string(), z.unknown()).default({}),
  credentials: z.record(z.string(), z.string().max(4000)).default({}),
  is_enabled: z.boolean().default(true),
});

export const portalAccountSchema = z.object({
  provider_code: z.string().min(1).max(40),
  name: z.string().min(1).max(160),
  external_account_id: z.string().max(190).optional(),
  credentials: z.record(z.string(), z.string().max(4000)).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
  auto_publish: z.boolean().default(false),
  listing_quota: z.coerce.number().int().min(0).optional(),
  is_enabled: z.boolean().default(true),
});

export const publishListingSchema = z.object({
  portal_account_ids: z.array(idSchema).min(1),
  validate_only: z.boolean().default(false),
});

export const webhookEndpointSchema = z.object({
  name: z.string().min(1).max(160),
  target_url: z.string().url().max(512),
  event_types: z.array(z.string().max(80)).min(1),
});

export const apiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string().max(80)).min(1),
  expires_at: z.coerce.date().optional(),
});

export const aiRequestSchema = z.object({
  feature: z.enum(AI_FEATURES),
  entity_type: z.string().max(40).optional(),
  entity_id: idSchema.optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  language: z.enum(['en', 'ar']).default('en'),
});

export const aiFeedbackSchema = z.object({
  artifact_id: idSchema.optional(),
  request_id: idSchema.optional(),
  rating: z.enum(['positive', 'negative', 'neutral']),
  comment: z.string().max(1000).optional(),
});

export const displaySchema = z.object({
  name: z.string().min(1).max(160),
  location: z.string().max(200).optional(),
  branch_id: idSchema.optional(),
  team_id: idSchema.optional(),
  playlist_id: idSchema.optional(),
  theme: z.string().max(40).default('midnight'),
  theme_overrides: z.record(z.string(), z.string().max(60)).optional(),
  privacy_settings: z
    .object({
      mask_agent_names: z.boolean().default(false),
      mask_amounts: z.boolean().default(false),
      hide_exact_address: z.boolean().default(true),
      show_client_initials_only: z.boolean().default(true),
    })
    .partial()
    .optional(),
  filters: z
    .object({
      branch_ids: z.array(idSchema).optional(),
      team_ids: z.array(idSchema).optional(),
      project_ids: z.array(idSchema).optional(),
      modules: z.array(z.enum(['ready', 'offplan'])).optional(),
      date_range: z.enum(['today', 'week', 'month', 'quarter', 'year']).optional(),
    })
    .optional(),
  slide_duration_seconds: z.coerce.number().int().min(5).max(300).default(15),
  transition: z.enum(['fade', 'slide', 'none']).default('fade'),
  auto_approve_events: z.boolean().default(false),
  orientation: z.enum(['landscape', 'portrait']).default('landscape'),
});

export const displayPairSchema = z.object({ code: z.string().min(6).max(12) });

export const displayClaimSchema = z.object({
  code: z.string().min(6).max(12),
  device_fingerprint: z.string().max(120).optional(),
  app_version: z.string().max(40).optional(),
});

export const playlistSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  is_default: z.boolean().default(false),
  slides: z
    .array(
      z.object({
        slide_type: z.enum(DISPLAY_SLIDE_TYPES),
        title: z.string().max(200).optional(),
        position: z.coerce.number().int().min(0),
        duration_seconds: z.coerce.number().int().min(3).max(300).optional(),
        is_enabled: z.boolean().default(true),
        config: z.record(z.string(), z.unknown()).default({}),
        filters: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .default([]),
});

export const salesEventApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(500).optional(),
});

export const pointsRuleSchema = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  event_type: z.enum([...SALES_EVENT_TYPES, 'lead_qualified', 'viewing_completed']),
  points: z.coerce.number().int().min(-1000).max(10000).default(0),
  calculation: z.enum(['fixed', 'per_amount']).default('fixed'),
  points_per_amount: z.coerce.number().min(0).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  effective_from: z.coerce.date().optional(),
  effective_to: z.coerce.date().optional(),
  is_active: z.boolean().default(true),
});

export const targetSchema = z.object({
  target_type: z.enum(['revenue', 'deals', 'listings', 'reservations', 'points']),
  scope_type: z.enum(['organization', 'branch', 'team', 'membership']),
  scope_id: idSchema.optional(),
  period_type: z.enum(['month', 'quarter', 'year']).default('month'),
  period_start: z.coerce.date(),
  period_end: z.coerce.date(),
  target_value: moneySchema,
  currency: z.string().length(3).default('AED'),
  module: z.enum(['ready', 'offplan']).optional(),
});

export const announcementSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  announcement_type: z.enum(['message', 'image', 'video', 'ticker']).default('message'),
  media_url: z.string().url().max(512).optional(),
  display_ids: z.array(idSchema).optional(),
  starts_at: z.coerce.date(),
  ends_at: z.coerce.date().optional(),
  duration_seconds: z.coerce.number().int().min(3).max(120).default(12),
  priority: z.coerce.number().int().min(1).max(1000).default(100),
});

export const inboundLeadSchema = z.object({
  external_id: z.string().max(120).optional(),
  source: z.string().max(60).optional(),
  portal_code: z.string().max(40).optional(),
  campaign: z.string().max(120).optional(),
  name: z.string().max(180).optional(),
  first_name: z.string().max(80).optional(),
  last_name: z.string().max(80).optional(),
  email: emailSchema.optional(),
  phone: z.string().max(40).optional(),
  message: z.string().max(8000).optional(),
  property_reference: z.string().max(80).optional(),
  listing_reference: z.string().max(80).optional(),
  project_reference: z.string().max(80).optional(),
  module: z.enum(['ready', 'offplan']).optional(),
  purpose: z.enum(['buy', 'rent', 'sell', 'lease_out', 'invest']).optional(),
  budget_min: moneySchema.optional(),
  budget_max: moneySchema.optional(),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  language: z.enum(['en', 'ar']).optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
  received_at: z.coerce.date().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});
