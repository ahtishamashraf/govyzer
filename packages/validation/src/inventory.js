import { z } from 'zod';
import { UNIT_STOCK_STATUSES, LISTING_STATUSES } from '@govyzer/domain/constants';
import { idSchema, moneySchema, searchSchema, percentageSchema } from './common.js';

export const developerSchema = z.object({
  name: z.string().min(1).max(180),
  name_ar: z.string().max(180).optional(),
  logo_url: z.string().url().max(512).optional(),
  description: z.string().max(8000).optional(),
  website: z.string().url().max(255).optional(),
  contact_email: z.string().email().max(190).optional(),
  contact_phone: z.string().max(40).optional(),
  license_number: z.string().max(80).optional(),
  default_commission_percentage: percentageSchema.optional(),
  is_active: z.boolean().default(true),
});

export const projectSchema = z.object({
  developer_id: idSchema,
  name: z.string().min(1).max(200),
  name_ar: z.string().max(200).optional(),
  project_type: z.enum(['residential', 'commercial', 'mixed_use']).default('residential'),
  status: z.enum(['announced', 'presale', 'selling', 'sold_out', 'under_construction', 'completed', 'on_hold']).default('announced'),
  construction_status: z.string().max(30).optional(),
  construction_percentage: z.coerce.number().int().min(0).max(100).optional(),
  city_id: idSchema.optional(),
  community_id: idSchema.optional(),
  subcommunity_id: idSchema.optional(),
  address_line: z.string().max(300).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  description: z.string().max(20000).optional(),
  description_ar: z.string().max(20000).optional(),
  launch_date: z.coerce.date().optional(),
  handover_date: z.coerce.date().optional(),
  escrow_account: z.string().max(120).optional(),
  permit_number: z.string().max(80).optional(),
  starting_price: moneySchema.optional(),
  total_units: z.coerce.number().int().min(0).optional(),
  assignment_policy: z
    .object({
      strategies: z.array(z.string().max(40)).default(['project_manager_inbox']),
      membership_ids: z.array(idSchema).optional(),
      team_ids: z.array(idSchema).optional(),
    })
    .optional(),
  default_manager_membership_id: idSchema.optional(),
  specialist_membership_ids: z.array(idSchema).optional(),
  amenity_codes: z.array(z.string().max(60)).optional(),
});

export const phaseSchema = z.object({
  name: z.string().min(1).max(160),
  code: z.string().min(1).max(40),
  status: z.string().max(30).default('planned'),
  launch_date: z.coerce.date().optional(),
  handover_date: z.coerce.date().optional(),
  total_units: z.coerce.number().int().min(0).optional(),
  position: z.coerce.number().int().min(0).default(0),
});

export const projectBuildingSchema = z.object({
  phase_id: idSchema.optional(),
  name: z.string().min(1).max(160),
  code: z.string().min(1).max(40),
  total_floors: z.coerce.number().int().min(0).optional(),
  total_units: z.coerce.number().int().min(0).optional(),
  handover_date: z.coerce.date().optional(),
});

export const unitTypeSchema = z.object({
  project_id: idSchema.optional(),
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  name_ar: z.string().max(160).optional(),
  property_type: z.string().max(40).default('apartment'),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  bathrooms: z.coerce.number().min(0).max(20).optional(),
  suite_area: z.coerce.number().min(0).optional(),
  balcony_area: z.coerce.number().min(0).optional(),
  total_area: z.coerce.number().min(0).optional(),
  size_unit: z.enum(['sqft', 'sqm']).default('sqft'),
  description: z.string().max(8000).optional(),
});

export const unitSchema = z.object({
  module: z.enum(['ready', 'offplan']).default('offplan'),
  project_id: idSchema.optional(),
  phase_id: idSchema.optional(),
  project_building_id: idSchema.optional(),
  unit_type_id: idSchema.optional(),
  building_id: idSchema.optional(),
  community_id: idSchema.optional(),
  city_id: idSchema.optional(),
  unit_number: z.string().min(1).max(60),
  floor_label: z.string().max(40).optional(),
  property_type: z.string().max(40).default('apartment'),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  bathrooms: z.coerce.number().min(0).max(20).optional(),
  built_up_area: z.coerce.number().min(0).optional(),
  plot_area: z.coerce.number().min(0).optional(),
  balcony_area: z.coerce.number().min(0).optional(),
  size_unit: z.enum(['sqft', 'sqm']).default('sqft'),
  parking_spaces: z.coerce.number().int().min(0).optional(),
  view: z.string().max(120).optional(),
  orientation: z.string().max(40).optional(),
  furnishing: z.enum(['furnished', 'unfurnished', 'partly_furnished']).optional(),
  base_price: moneySchema.optional(),
  current_price: moneySchema.optional(),
  currency: z.string().length(3).default('AED'),
  stock_status: z.enum(UNIT_STOCK_STATUSES).default('draft'),
  handover_date: z.coerce.date().optional(),
  payment_plan_id: idSchema.optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export const unitStatusChangeSchema = z.object({
  stock_status: z.enum(UNIT_STOCK_STATUSES),
  reason: z.string().max(240).optional(),
  is_override: z.boolean().default(false),
});

export const unitSearchSchema = searchSchema.extend({
  project_id: idSchema.optional(),
  phase_id: idSchema.optional(),
  project_building_id: idSchema.optional(),
  developer_id: idSchema.optional(),
  unit_type_id: idSchema.optional(),
  stock_status: z.union([z.enum(UNIT_STOCK_STATUSES), z.array(z.enum(UNIT_STOCK_STATUSES))]).optional(),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  bedrooms_min: z.coerce.number().int().min(0).max(20).optional(),
  bedrooms_max: z.coerce.number().int().min(0).max(20).optional(),
  price_min: moneySchema.optional(),
  price_max: moneySchema.optional(),
  area_min: z.coerce.number().min(0).optional(),
  area_max: z.coerce.number().min(0).optional(),
  view: z.string().max(120).optional(),
  floor_label: z.string().max(40).optional(),
  unit_number: z.string().max(60).optional(),
  payment_plan_id: idSchema.optional(),
  handover_from: z.coerce.date().optional(),
  handover_to: z.coerce.date().optional(),
});

export const paymentPlanSchema = z.object({
  project_id: idSchema.optional(),
  name: z.string().min(1).max(160),
  code: z.string().min(1).max(60),
  plan_type: z.enum(['construction_linked', 'time_linked', 'post_handover', 'cash', 'custom']).default('construction_linked'),
  description: z.string().max(4000).optional(),
  down_payment_percentage: percentageSchema.optional(),
  on_handover_percentage: percentageSchema.optional(),
  post_handover_percentage: percentageSchema.optional(),
  post_handover_months: z.coerce.number().int().min(0).max(240).optional(),
  booking_amount: moneySchema.optional(),
  dld_fee_percentage: percentageSchema.default(4),
  admin_fee: moneySchema.optional(),
  currency: z.string().length(3).default('AED'),
  is_default: z.boolean().default(false),
  installments: z
    .array(
      z.object({
        position: z.coerce.number().int().min(1),
        label: z.string().min(1).max(160),
        percentage: percentageSchema.optional(),
        fixed_amount: moneySchema.optional(),
        trigger_type: z.enum(['milestone', 'months_after_booking', 'fixed_date', 'on_handover']).default('milestone'),
        milestone: z.string().max(120).optional(),
        months_after_booking: z.coerce.number().int().min(0).max(240).optional(),
        due_on: z.coerce.date().optional(),
      })
    )
    .default([]),
});

export const priceListSchema = z.object({
  project_id: idSchema.optional(),
  name: z.string().min(1).max(160),
  currency: z.string().length(3).default('AED'),
  effective_from: z.coerce.date(),
  effective_to: z.coerce.date().optional(),
  items: z
    .array(
      z.object({
        unit_id: idSchema.optional(),
        unit_type_id: idSchema.optional(),
        price: moneySchema,
        discount_percentage: percentageSchema.optional(),
        payment_plan_id: idSchema.optional(),
      })
    )
    .default([]),
});

export const stockImportSchema = z.object({
  project_id: idSchema,
  mode: z.enum(['validate', 'commit']).default('validate'),
  idempotency_key: z.string().max(190).optional(),
  rows: z
    .array(
      z.object({
        unit_number: z.string().min(1).max(60),
        unit_type_code: z.string().max(60).optional(),
        building_code: z.string().max(40).optional(),
        phase_code: z.string().max(40).optional(),
        floor_label: z.string().max(40).optional(),
        property_type: z.string().max(40).optional(),
        bedrooms: z.coerce.number().int().min(0).max(20).optional(),
        bathrooms: z.coerce.number().min(0).max(20).optional(),
        built_up_area: z.coerce.number().min(0).optional(),
        balcony_area: z.coerce.number().min(0).optional(),
        plot_area: z.coerce.number().min(0).optional(),
        size_unit: z.enum(['sqft', 'sqm']).optional(),
        parking_spaces: z.coerce.number().int().min(0).optional(),
        view: z.string().max(120).optional(),
        base_price: moneySchema.optional(),
        current_price: moneySchema.optional(),
        stock_status: z.enum(UNIT_STOCK_STATUSES).optional(),
        payment_plan_code: z.string().max(60).optional(),
        handover_date: z.coerce.date().optional(),
      })
    )
    .min(1)
    .max(5000),
});

export const holdSchema = z.object({
  unit_id: idSchema,
  lead_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  reason: z.string().max(300).optional(),
  duration_minutes: z.coerce.number().int().min(5).max(10080).default(60),
});

export const reservationSchema = z.object({
  unit_id: idSchema,
  contact_id: idSchema,
  lead_id: idSchema.optional(),
  payment_plan_id: idSchema.optional(),
  agent_membership_id: idSchema.optional(),
  unit_price: moneySchema.optional(),
  reservation_amount: moneySchema.optional(),
  discount_amount: moneySchema.optional(),
  currency: z.string().length(3).default('AED'),
  expires_in_hours: z.coerce.number().int().min(1).max(2160).default(72),
  terms: z.record(z.string(), z.unknown()).optional(),
});

export const reservationExtendSchema = z.object({
  additional_hours: z.coerce.number().int().min(1).max(2160),
  reason: z.string().max(300).optional(),
});

export const reservationCancelSchema = z.object({
  reason: z.string().min(1).max(300),
  release_unit: z.boolean().default(true),
});

export const listingSchema = z.object({
  unit_id: idSchema.optional(),
  offering_type: z.enum(['sale', 'rent']).default('sale'),
  property_category: z.enum(['residential', 'commercial']).default('residential'),
  property_type: z.string().max(40).default('apartment'),
  title: z.string().min(5).max(250),
  title_ar: z.string().max(250).optional(),
  description: z.string().max(20000).optional(),
  description_ar: z.string().max(20000).optional(),
  city_id: idSchema.optional(),
  community_id: idSchema.optional(),
  subcommunity_id: idSchema.optional(),
  building_id: idSchema.optional(),
  address_line: z.string().max(300).optional(),
  hide_exact_address: z.boolean().default(false),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  price: moneySchema.optional(),
  currency: z.string().length(3).default('AED'),
  rent_frequency: z.enum(['yearly', 'monthly', 'weekly', 'daily']).optional(),
  service_charge: moneySchema.optional(),
  cheques_allowed: z.coerce.number().int().min(1).max(12).optional(),
  price_on_application: z.boolean().default(false),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  bathrooms: z.coerce.number().min(0).max(20).optional(),
  built_up_area: z.coerce.number().min(0).optional(),
  plot_area: z.coerce.number().min(0).optional(),
  size_unit: z.enum(['sqft', 'sqm']).default('sqft'),
  parking_spaces: z.coerce.number().int().min(0).optional(),
  furnishing: z.enum(['furnished', 'unfurnished', 'partly_furnished']).optional(),
  view: z.string().max(120).optional(),
  floor_number: z.coerce.number().int().optional(),
  total_floors: z.coerce.number().int().optional(),
  completion_year: z.coerce.number().int().min(1900).max(2100).optional(),
  occupancy_status: z.enum(['vacant', 'occupied', 'vacant_on_transfer']).default('vacant'),
  available_from: z.coerce.date().optional(),
  is_exclusive: z.boolean().default(false),
  exclusive_until: z.coerce.date().optional(),
  owner_contact_id: idSchema.optional(),
  landlord_contact_id: idSchema.optional(),
  primary_agent_membership_id: idSchema.optional(),
  fallback_membership_id: idSchema.optional(),
  fallback_team_id: idSchema.optional(),
  manager_membership_id: idSchema.optional(),
  permit_number: z.string().max(80).optional(),
  permit_issued_on: z.coerce.date().optional(),
  permit_expires_on: z.coerce.date().optional(),
  amenity_codes: z.array(z.string().max(60)).optional(),
  version: z.coerce.number().int().optional(),
});

export const listingStatusSchema = z.object({
  status: z.enum(LISTING_STATUSES),
  reason: z.string().max(500).optional(),
});

export const listingApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(500).optional(),
  checklist: z.record(z.string(), z.boolean()).optional(),
});

export const listingSearchSchema = searchSchema.extend({
  status: z.union([z.enum(LISTING_STATUSES), z.array(z.enum(LISTING_STATUSES))]).optional(),
  offering_type: z.enum(['sale', 'rent']).optional(),
  property_type: z.string().max(40).optional(),
  community_id: idSchema.optional(),
  agent_membership_id: idSchema.optional(),
  price_min: moneySchema.optional(),
  price_max: moneySchema.optional(),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  portal_status: z.string().max(30).optional(),
  permit_expiring_days: z.coerce.number().int().min(0).max(365).optional(),
});

export const mediaUploadSchema = z.object({
  entity_type: z.enum(['listing', 'unit', 'project', 'developer', 'organization', 'announcement', 'document']),
  entity_id: idSchema,
  asset_type: z.enum(['image', 'video', 'floor_plan', 'brochure', 'document', 'tour']).default('image'),
  file_name: z.string().min(1).max(255),
  mime_type: z.string().min(3).max(120),
  size_bytes: z.coerce.number().int().min(1),
  checksum: z.string().max(64).optional(),
});

export const mediaReorderSchema = z.object({
  items: z.array(z.object({ id: idSchema, position: z.coerce.number().int().min(0), is_primary: z.boolean().optional() })).min(1),
});
