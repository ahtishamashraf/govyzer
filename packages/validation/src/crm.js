import { z } from 'zod';
import { CONTACT_ROLES, IDENTIFIER_TYPES, LEAD_PURPOSES } from '@govyzer/domain/constants';
import { idSchema, emailSchema, moneySchema, localeSchema, searchSchema } from './common.js';

export const contactIdentifierSchema = z.object({
  identifier_type: z.enum(IDENTIFIER_TYPES),
  value: z.string().min(3).max(190),
  label: z.string().max(60).optional(),
  is_primary: z.boolean().default(false),
});

export const contactCreateSchema = z.object({
  contact_type: z.enum(['individual', 'company']).default('individual'),
  first_name: z.string().max(80).optional(),
  last_name: z.string().max(80).optional(),
  display_name: z.string().min(1).max(180).optional(),
  company_name: z.string().max(180).optional(),
  nationality: z.string().length(2).optional(),
  preferred_language: localeSchema.default('en'),
  preferred_contact_method: z.enum(['phone', 'email', 'whatsapp', 'sms']).default('phone'),
  owner_membership_id: idSchema.optional(),
  source_id: idSchema.optional(),
  roles: z.array(z.enum(CONTACT_ROLES)).default([]),
  identifiers: z.array(contactIdentifierSchema).default([]),
  do_not_contact: z.boolean().default(false),
  summary: z.string().max(4000).optional(),
});

export const contactUpdateSchema = contactCreateSchema.partial().extend({
  version: z.coerce.number().int().optional(),
});

export const contactMergeSchema = z.object({
  source_contact_id: idSchema,
  target_contact_id: idSchema,
  field_choices: z.record(z.string(), z.string()).optional(),
});

export const leadRequirementSchema = z.object({
  purpose: z.enum(LEAD_PURPOSES).default('buy'),
  module: z.enum(['ready', 'offplan']).default('ready'),
  property_types: z.array(z.string().max(40)).optional(),
  bedrooms_min: z.coerce.number().int().min(0).max(20).optional(),
  bedrooms_max: z.coerce.number().int().min(0).max(20).optional(),
  bathrooms_min: z.coerce.number().min(0).max(20).optional(),
  budget_min: moneySchema.optional(),
  budget_max: moneySchema.optional(),
  currency: z.string().length(3).default('AED'),
  size_min: z.coerce.number().min(0).optional(),
  size_max: z.coerce.number().min(0).optional(),
  size_unit: z.enum(['sqft', 'sqm']).default('sqft'),
  community_ids: z.array(idSchema).optional(),
  city_ids: z.array(idSchema).optional(),
  amenities: z.array(z.string().max(60)).optional(),
  views: z.array(z.string().max(60)).optional(),
  handover_from: z.coerce.date().optional(),
  handover_to: z.coerce.date().optional(),
  move_in_from: z.coerce.date().optional(),
  payment_plan_preference: z.string().max(60).optional(),
  furnishing: z.enum(['furnished', 'unfurnished', 'partly_furnished']).optional(),
  rent_frequency: z.enum(['yearly', 'monthly', 'weekly', 'daily']).optional(),
  notes: z.string().max(4000).optional(),
});

export const leadCreateSchema = z.object({
  contact_id: idSchema.optional(),
  contact: contactCreateSchema.optional(),
  module: z.enum(['ready', 'offplan']).default('ready'),
  purpose: z.enum(LEAD_PURPOSES).default('buy'),
  pipeline: z.string().max(24).optional(),
  stage_code: z.string().max(60).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  source_id: idSchema.optional(),
  source_code: z.string().max(60).optional(),
  campaign_id: idSchema.optional(),
  portal_code: z.string().max(40).optional(),
  external_lead_id: z.string().max(120).optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
  listing_id: idSchema.optional(),
  project_id: idSchema.optional(),
  unit_id: idSchema.optional(),
  property_reference: z.string().max(80).optional(),
  language: localeSchema.default('en'),
  estimated_value: moneySchema.optional(),
  financing: z.enum(['cash', 'mortgage', 'undecided']).optional(),
  timeframe: z.enum(['immediate', '1_3_months', '3_6_months', '6_12_months', 'exploring']).optional(),
  notes: z.string().max(8000).optional(),
  referred_by_contact_id: idSchema.optional(),
  assigned_membership_id: idSchema.optional(),
  requirements: z.array(leadRequirementSchema).default([]),
  tags: z.array(z.string().max(60)).optional(),
  auto_assign: z.boolean().default(true),
});

export const leadUpdateSchema = leadCreateSchema
  .omit({ contact: true, auto_assign: true })
  .partial()
  .extend({
    stage_code: z.string().max(60).optional(),
    substage: z.string().max(60).optional(),
    next_action: z.string().max(200).optional(),
    next_action_at: z.coerce.date().optional(),
    loss_reason: z.string().max(120).optional(),
    version: z.coerce.number().int().optional(),
  });

export const leadStageChangeSchema = z.object({
  stage_code: z.string().min(1).max(60),
  reason: z.string().max(240).optional(),
  loss_reason: z.string().max(120).optional(),
});

export const leadAssignSchema = z.object({
  membership_id: idSchema.nullable().optional(),
  reason: z.string().max(240).optional(),
  auto: z.boolean().default(false),
});

export const leadPoolReleaseSchema = z.object({
  reason: z.string().max(240).optional(),
  eligible_membership_ids: z.array(idSchema).optional(),
  expires_at: z.coerce.date().optional(),
});

export const leadSearchSchema = searchSchema.extend({
  module: z.enum(['ready', 'offplan']).optional(),
  stage_code: z.string().max(60).optional(),
  status: z.string().max(24).optional(),
  assigned_membership_id: idSchema.optional(),
  source_id: idSchema.optional(),
  campaign_id: idSchema.optional(),
  project_id: idSchema.optional(),
  listing_id: idSchema.optional(),
  in_pool: z.coerce.boolean().optional(),
  created_from: z.coerce.date().optional(),
  created_to: z.coerce.date().optional(),
});

export const noteSchema = z.object({
  entity_type: z.enum(['contact', 'lead', 'listing', 'deal', 'unit', 'project', 'reservation']),
  entity_id: idSchema,
  body: z.string().min(1).max(8000),
  is_private: z.boolean().default(false),
  visibility: z.enum(['private', 'team', 'organization']).default('team'),
});

export const taskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  entity_type: z.string().max(40).optional(),
  entity_id: idSchema.optional(),
  assigned_membership_id: idSchema.optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  task_type: z.enum(['follow_up', 'call', 'email', 'whatsapp', 'document', 'other']).default('follow_up'),
  due_at: z.coerce.date().optional(),
});

export const meetingSchema = z.object({
  title: z.string().min(1).max(200),
  meeting_type: z.enum(['client_meeting', 'viewing', 'call', 'site_visit', 'internal']).default('client_meeting'),
  module: z.enum(['ready', 'offplan']).default('ready'),
  lead_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  project_id: idSchema.optional(),
  unit_id: idSchema.optional(),
  listing_id: idSchema.optional(),
  location: z.string().max(240).optional(),
  location_type: z.enum(['office', 'site', 'online', 'client_location']).default('office'),
  meeting_url: z.string().url().max(512).optional(),
  starts_at: z.coerce.date(),
  ends_at: z.coerce.date(),
  timezone: z.string().max(64).default('Asia/Dubai'),
  attendee_membership_ids: z.array(idSchema).default([]),
  attendee_emails: z.array(emailSchema).default([]),
  notes: z.string().max(8000).optional(),
});

export const meetingOutcomeSchema = z.object({
  status: z.enum(['completed', 'no_show', 'cancelled', 'rescheduled']),
  outcome: z.string().max(40).optional(),
  notes: z.string().max(8000).optional(),
});

export const viewingSchema = z.object({
  lead_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  listing_id: idSchema.optional(),
  unit_id: idSchema.optional(),
  scheduled_at: z.coerce.date(),
  agent_membership_id: idSchema.optional(),
});

export const viewingFeedbackSchema = z.object({
  status: z.enum(['completed', 'cancelled', 'no_show']),
  feedback: z.string().max(2000).optional(),
  interest_level: z.coerce.number().int().min(1).max(5).optional(),
  outcome: z.enum(['interested', 'not_interested', 'offer', 'follow_up']).optional(),
});
