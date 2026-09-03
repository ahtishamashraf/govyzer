/** Product modules a membership can be entitled to independently. */
export const MODULES = Object.freeze({
  READY: 'ready',
  OFFPLAN: 'offplan',
  SALES_SCREEN: 'sales_screen',
  FINANCE: 'finance',
  ADMIN: 'admin',
});

export const MODULE_LIST = Object.freeze(Object.values(MODULES));

export const RECORD_SCOPES = Object.freeze([
  'own',
  'assigned',
  'team',
  'branch',
  'organization',
]);

export const SCOPE_RANK = Object.freeze({
  own: 0,
  assigned: 1,
  team: 2,
  branch: 3,
  organization: 4,
});

export const CONTACT_ROLES = Object.freeze([
  'buyer',
  'seller',
  'landlord',
  'tenant',
  'investor',
  'owner',
  'external_broker',
  'referral_partner',
  'company_representative',
  'other',
]);

export const IDENTIFIER_TYPES = Object.freeze([
  'email',
  'phone',
  'whatsapp',
  'passport',
  'emirates_id',
  'trade_license',
  'other',
]);

export const LEAD_PURPOSES = Object.freeze(['buy', 'rent', 'sell', 'lease_out', 'invest']);

export const DEFAULT_LEAD_STAGES = Object.freeze([
  { code: 'new_inquiry', en: 'New Inquiry', ar: 'استفسار جديد', category: 'open', entry: true },
  { code: 'attempting_contact', en: 'Attempting Contact', ar: 'محاولة التواصل', category: 'open' },
  { code: 'contacted', en: 'Contacted', ar: 'تم التواصل', category: 'open' },
  { code: 'qualified', en: 'Qualified', ar: 'مؤهل', category: 'open' },
  { code: 'meeting_scheduled', en: 'Meeting/Viewing Scheduled', ar: 'موعد محدد', category: 'open' },
  { code: 'meeting_completed', en: 'Meeting/Viewing Completed', ar: 'تم الاجتماع', category: 'open' },
  { code: 'negotiation', en: 'Negotiation/Offer', ar: 'تفاوض/عرض', category: 'open' },
  { code: 'reservation', en: 'Reservation/Booking', ar: 'حجز', category: 'open' },
  { code: 'won', en: 'Won', ar: 'مكسوب', category: 'won' },
  { code: 'lost', en: 'Lost', ar: 'خسارة', category: 'lost' },
  { code: 'junk', en: 'Junk/Invalid', ar: 'غير صالح', category: 'junk' },
]);

export const LISTING_STATUSES = Object.freeze([
  'draft',
  'internal_review',
  'approved',
  'publishing',
  'published',
  'partially_published',
  'rejected',
  'unpublished',
  'expired',
  'withdrawn',
  'archived',
]);

export const PUBLICATION_STATUSES = Object.freeze([
  'pending',
  'validating',
  'queued',
  'publishing',
  'published',
  'failed',
  'unpublishing',
  'unpublished',
  'rejected',
]);

export const UNIT_STOCK_STATUSES = Object.freeze([
  'draft',
  'unreleased',
  'available',
  'blocked',
  'on_hold',
  'reserved',
  'booked',
  'sold',
  'cancelled',
  'withdrawn',
  'unavailable',
]);

export const RESERVATION_STATUSES = Object.freeze([
  'pending',
  'confirmed',
  'extended',
  'expired',
  'cancelled',
  'converted',
]);

export const DEAL_STAGES = Object.freeze([
  'draft',
  'documentation',
  'approval',
  'signed',
  'won',
  'lost',
  'cancelled',
]);

export const DEAL_TYPES = Object.freeze(['ready_sale', 'ready_rental', 'offplan_sale']);

export const DEAL_PARTY_ROLES = Object.freeze([
  'buyer',
  'seller',
  'tenant',
  'landlord',
  'developer',
  'internal_agent',
  'manager',
  'referral_partner',
  'external_broker',
  'company',
]);

export const COMMISSION_RECIPIENT_TYPES = Object.freeze([
  'agent',
  'company',
  'manager',
  'team_leader',
  'referral_partner',
  'external_broker',
  'branch',
]);

export const COMMISSION_BASES = Object.freeze([
  'gross_before_vat',
  'gross_after_vat',
  'net_after_costs',
]);

export const ASSIGNMENT_STRATEGIES = Object.freeze([
  'listing_agent',
  'project_manager_inbox',
  'round_robin',
  'weighted_round_robin',
  'language_match',
  'project_specialist',
  'area_specialist',
  'property_type',
  'budget_band',
  'source_owner',
  'shift',
  'least_workload',
  'manual',
]);

export const SALES_EVENT_TYPES = Object.freeze([
  'deal_won',
  'listing_published',
  'reservation_created',
  'booking_created',
  'milestone_reached',
  'announcement',
  'target_reached',
]);

export const DISPLAY_SLIDE_TYPES = Object.freeze([
  'new_deal_celebration',
  'new_listing',
  'top_agents',
  'top_teams',
  'top_deals',
  'total_revenue',
  'target_progress',
  'deal_count',
  'listing_count',
  'offplan_reservations',
  'stock_summary',
  'points_leaderboard',
  'milestones',
  'announcements',
  'media',
  'ticker',
]);

export const WORKFLOW_TRIGGERS = Object.freeze([
  'record_created',
  'record_updated',
  'stage_changed',
  'assignment_changed',
  'no_activity_for',
  'sla_breached',
  'meeting_approaching',
  'reservation_expiring',
  'document_expiring',
  'listing_rejected',
  'portal_error',
  'deal_won',
  'deal_lost',
  'webhook_received',
  'scheduled_time',
]);

export const WORKFLOW_ACTIONS = Object.freeze([
  'notify_user',
  'notify_manager',
  'assign_lead',
  'add_to_lead_pool',
  'create_task',
  'update_field',
  'change_stage',
  'send_email',
  'send_whatsapp',
  'call_webhook',
  'add_points',
  'create_sales_event',
  'wait',
]);

export const AI_FEATURES = Object.freeze([
  'lead_scoring',
  'lead_matching',
  'conversation_summary',
  'reply_suggestion',
  'listing_copy',
  'price_intelligence',
  'duplicate_detection',
  'natural_language_report',
  'meeting_summary',
  'data_quality',
]);

export const DEFAULT_ORGANIZATION_DEFAULTS = Object.freeze({
  country: 'AE',
  default_locale: 'en',
  default_currency: 'AED',
  timezone: 'Asia/Dubai',
  date_format: 'dd/MM/yyyy',
  vat_percentage: 5,
  commission_base: 'gross_before_vat',
});
