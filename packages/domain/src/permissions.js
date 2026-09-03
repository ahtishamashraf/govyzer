import { MODULES, SCOPE_RANK } from './constants.js';
import { ForbiddenError } from './errors.js';

/**
 * Every permission the API can check. `module` drives module entitlement checks so a
 * membership with only the Ready module can never act on Off-plan data.
 */
export const PERMISSIONS = Object.freeze([
  // Organization administration
  ['organization.read', MODULES.ADMIN, 'View organization settings'],
  ['organization.update', MODULES.ADMIN, 'Update organization settings and defaults'],
  ['organization.branding', MODULES.ADMIN, 'Manage branding and white-labeling'],
  ['organization.domains', MODULES.ADMIN, 'Manage subdomains and custom domains'],
  ['organization.billing', MODULES.ADMIN, 'Manage plan, limits and entitlements'],
  ['users.read', MODULES.ADMIN, 'View users and memberships'],
  ['users.invite', MODULES.ADMIN, 'Invite users'],
  ['users.update', MODULES.ADMIN, 'Update memberships, hierarchy and modules'],
  ['users.deactivate', MODULES.ADMIN, 'Deactivate memberships'],
  ['roles.read', MODULES.ADMIN, 'View roles and permissions'],
  ['roles.manage', MODULES.ADMIN, 'Create and update custom roles'],
  ['audit.read', MODULES.ADMIN, 'Read audit logs'],
  ['custom_fields.manage', MODULES.ADMIN, 'Manage custom field definitions'],
  ['api_keys.manage', MODULES.ADMIN, 'Manage tenant API keys'],
  ['data.export', MODULES.ADMIN, 'Export tenant data'],
  ['data.delete', MODULES.ADMIN, 'Request and approve data deletion'],

  // Contacts and CRM
  ['contacts.read', MODULES.READY, 'View contacts'],
  ['contacts.create', MODULES.READY, 'Create contacts'],
  ['contacts.update', MODULES.READY, 'Update contacts'],
  ['contacts.delete', MODULES.READY, 'Delete contacts'],
  ['contacts.merge', MODULES.READY, 'Merge duplicate contacts'],
  ['contacts.view_sensitive', MODULES.READY, 'View full contact identifiers'],
  ['leads.read', MODULES.READY, 'View leads'],
  ['leads.create', MODULES.READY, 'Create leads'],
  ['leads.update', MODULES.READY, 'Update leads'],
  ['leads.delete', MODULES.READY, 'Delete leads'],
  ['leads.assign', MODULES.READY, 'Assign or reassign leads'],
  ['leads.claim', MODULES.READY, 'Claim leads from the pool'],
  ['leads.pool_manage', MODULES.READY, 'Release leads to the pool and manage the pool'],
  ['leads.export', MODULES.READY, 'Export leads'],
  ['activities.read', MODULES.READY, 'View tasks, meetings, viewings and notes'],
  ['activities.manage', MODULES.READY, 'Create and update tasks, meetings and viewings'],
  ['communications.read', MODULES.READY, 'View communication timelines'],
  ['communications.send', MODULES.READY, 'Send messages through connected channels'],
  ['communications.read_team', MODULES.READY, 'View conversations of other agents'],

  // Ready listings
  ['listings.read', MODULES.READY, 'View listings'],
  ['listings.create', MODULES.READY, 'Create listings'],
  ['listings.update', MODULES.READY, 'Update listings'],
  ['listings.delete', MODULES.READY, 'Delete listings'],
  ['listings.approve', MODULES.READY, 'Approve or reject listings'],
  ['listings.publish', MODULES.READY, 'Publish and unpublish listings on portals'],
  ['listings.manage_media', MODULES.READY, 'Manage listing media'],
  ['portals.read', MODULES.READY, 'View portal accounts and publication status'],
  ['portals.manage', MODULES.READY, 'Configure portal accounts and mappings'],

  // Off-plan
  ['developers.read', MODULES.OFFPLAN, 'View developers'],
  ['developers.manage', MODULES.OFFPLAN, 'Create and update developers'],
  ['projects.read', MODULES.OFFPLAN, 'View projects'],
  ['projects.manage', MODULES.OFFPLAN, 'Create and update projects, phases and buildings'],
  ['units.read', MODULES.OFFPLAN, 'View unit inventory'],
  ['units.manage', MODULES.OFFPLAN, 'Create and update units and stock status'],
  ['units.import', MODULES.OFFPLAN, 'Bulk import unit stock'],
  ['units.override_status', MODULES.OFFPLAN, 'Override unit stock status'],
  ['prices.manage', MODULES.OFFPLAN, 'Manage price lists and payment plans'],
  ['holds.create', MODULES.OFFPLAN, 'Place unit holds'],
  ['holds.release', MODULES.OFFPLAN, 'Release unit holds'],
  ['reservations.read', MODULES.OFFPLAN, 'View reservations'],
  ['reservations.create', MODULES.OFFPLAN, 'Create reservations'],
  ['reservations.extend', MODULES.OFFPLAN, 'Extend reservations'],
  ['reservations.cancel', MODULES.OFFPLAN, 'Cancel reservations'],
  ['bookings.manage', MODULES.OFFPLAN, 'Create and manage bookings'],

  // Deals and finance
  ['deals.read', MODULES.READY, 'View deals'],
  ['deals.create', MODULES.READY, 'Create deals'],
  ['deals.update', MODULES.READY, 'Update deals'],
  ['deals.approve', MODULES.FINANCE, 'Approve deals and overrides'],
  ['deals.win', MODULES.READY, 'Mark deals as won'],
  ['documents.read', MODULES.READY, 'View documents'],
  ['documents.generate', MODULES.READY, 'Generate documents from templates'],
  ['documents.templates', MODULES.ADMIN, 'Manage document templates'],
  ['invoices.read', MODULES.FINANCE, 'View invoices and payments'],
  ['invoices.manage', MODULES.FINANCE, 'Create invoices, payments and receipts'],
  ['commissions.read', MODULES.FINANCE, 'View commission calculations'],
  ['commissions.read_own', MODULES.READY, 'View own commission lines'],
  ['commissions.manage', MODULES.FINANCE, 'Manage commission plans and rules'],
  ['commissions.approve', MODULES.FINANCE, 'Approve commission overrides and disbursements'],

  // Automation, integrations, AI
  ['workflows.read', MODULES.ADMIN, 'View workflows'],
  ['workflows.manage', MODULES.ADMIN, 'Create, publish and disable workflows'],
  ['integrations.read', MODULES.ADMIN, 'View integration connections and health'],
  ['integrations.manage', MODULES.ADMIN, 'Connect and configure integrations'],
  ['webhooks.manage', MODULES.ADMIN, 'Manage outbound webhook endpoints'],
  ['ai.use', MODULES.READY, 'Use AI assistance features'],
  ['ai.manage', MODULES.ADMIN, 'Configure AI settings and view usage'],

  // Reporting
  ['reports.read', MODULES.READY, 'View dashboards and reports'],
  ['reports.read_organization', MODULES.ADMIN, 'View organization wide reporting'],
  ['reports.schedule', MODULES.ADMIN, 'Schedule report delivery'],

  // Sales screen
  ['sales_screen.read', MODULES.SALES_SCREEN, 'View sales displays and configuration'],
  ['sales_screen.manage', MODULES.SALES_SCREEN, 'Create, pair, configure and revoke displays'],
  ['sales_screen.approve_events', MODULES.SALES_SCREEN, 'Approve events shown on displays'],
  ['sales_screen.points', MODULES.SALES_SCREEN, 'Manage points rules and targets'],
  ['sales_screen.announce', MODULES.SALES_SCREEN, 'Publish announcements to displays'],
]);

export const PERMISSION_CODES = Object.freeze(PERMISSIONS.map(([code]) => code));

export const PERMISSION_MODULE = Object.freeze(
  Object.fromEntries(PERMISSIONS.map(([code, module]) => [code, module]))
);

const ALL = PERMISSION_CODES;

const agentPermissions = [
  'contacts.read',
  'contacts.create',
  'contacts.update',
  'leads.read',
  'leads.create',
  'leads.update',
  'leads.claim',
  'activities.read',
  'activities.manage',
  'communications.read',
  'communications.send',
  'listings.read',
  'listings.create',
  'listings.update',
  'listings.manage_media',
  'projects.read',
  'units.read',
  'reservations.read',
  'reservations.create',
  'holds.create',
  'deals.read',
  'deals.create',
  'deals.update',
  'documents.read',
  'documents.generate',
  'commissions.read_own',
  'reports.read',
  'ai.use',
];

/** Default roles seeded into every organization. Tenants may add custom roles. */
export const DEFAULT_ROLES = Object.freeze([
  {
    code: 'org_owner',
    name: 'Organization Owner',
    priority: 10,
    scope: 'organization',
    modules: ['ready', 'offplan', 'sales_screen', 'finance', 'admin'],
    permissions: ALL,
  },
  {
    code: 'org_admin',
    name: 'Administrator',
    priority: 20,
    scope: 'organization',
    modules: ['ready', 'offplan', 'sales_screen', 'finance', 'admin'],
    permissions: ALL.filter((code) => code !== 'organization.billing'),
  },
  {
    code: 'branch_manager',
    name: 'Branch Manager',
    priority: 30,
    scope: 'branch',
    modules: ['ready', 'offplan', 'sales_screen'],
    permissions: [
      ...agentPermissions,
      'leads.assign',
      'leads.pool_manage',
      'leads.export',
      'leads.delete',
      'contacts.merge',
      'contacts.view_sensitive',
      'communications.read_team',
      'listings.approve',
      'listings.publish',
      'listings.delete',
      'portals.read',
      'units.manage',
      'reservations.extend',
      'reservations.cancel',
      'bookings.manage',
      'deals.win',
      'commissions.read',
      'reports.read_organization',
      'sales_screen.read',
      'users.read',
    ],
  },
  {
    code: 'sales_manager',
    name: 'Sales Manager',
    priority: 40,
    scope: 'team',
    modules: ['ready', 'offplan', 'sales_screen'],
    permissions: [
      ...agentPermissions,
      'leads.assign',
      'leads.pool_manage',
      'leads.export',
      'contacts.view_sensitive',
      'communications.read_team',
      'listings.approve',
      'listings.publish',
      'reservations.extend',
      'bookings.manage',
      'deals.win',
      'commissions.read',
      'sales_screen.read',
      'users.read',
    ],
  },
  {
    code: 'team_leader',
    name: 'Team Leader',
    priority: 50,
    scope: 'team',
    modules: ['ready', 'offplan'],
    permissions: [...agentPermissions, 'leads.assign', 'communications.read_team', 'listings.approve'],
  },
  {
    code: 'agent',
    name: 'Agent',
    priority: 60,
    scope: 'assigned',
    modules: ['ready'],
    permissions: agentPermissions,
  },
  {
    code: 'offplan_agent',
    name: 'Off-plan Agent',
    priority: 60,
    scope: 'assigned',
    modules: ['offplan'],
    permissions: agentPermissions,
  },
  {
    code: 'listing_admin',
    name: 'Listing Administrator',
    priority: 55,
    scope: 'organization',
    modules: ['ready'],
    permissions: [
      'contacts.read',
      'leads.read',
      'listings.read',
      'listings.create',
      'listings.update',
      'listings.approve',
      'listings.publish',
      'listings.manage_media',
      'listings.delete',
      'portals.read',
      'portals.manage',
      'reports.read',
      'activities.read',
    ],
  },
  {
    code: 'offplan_admin',
    name: 'Off-plan Administrator',
    priority: 55,
    scope: 'organization',
    modules: ['offplan'],
    permissions: [
      'developers.read',
      'developers.manage',
      'projects.read',
      'projects.manage',
      'units.read',
      'units.manage',
      'units.import',
      'units.override_status',
      'prices.manage',
      'holds.create',
      'holds.release',
      'reservations.read',
      'reservations.extend',
      'reservations.cancel',
      'bookings.manage',
      'leads.read',
      'contacts.read',
      'reports.read',
    ],
  },
  {
    code: 'finance',
    name: 'Finance',
    priority: 45,
    scope: 'organization',
    modules: ['finance', 'ready', 'offplan'],
    permissions: [
      'deals.read',
      'deals.approve',
      'invoices.read',
      'invoices.manage',
      'commissions.read',
      'commissions.manage',
      'commissions.approve',
      'documents.read',
      'documents.generate',
      'reports.read',
      'reports.read_organization',
      'contacts.read',
    ],
  },
  {
    code: 'compliance',
    name: 'Compliance',
    priority: 45,
    scope: 'organization',
    modules: ['ready', 'offplan', 'admin'],
    permissions: [
      'listings.read',
      'listings.approve',
      'documents.read',
      'documents.templates',
      'audit.read',
      'contacts.read',
      'contacts.view_sensitive',
      'deals.read',
      'reports.read',
      'data.export',
      'data.delete',
    ],
  },
  {
    code: 'marketing',
    name: 'Marketing',
    priority: 60,
    scope: 'organization',
    modules: ['ready', 'offplan'],
    permissions: [
      'listings.read',
      'projects.read',
      'units.read',
      'leads.read',
      'reports.read',
      'ai.use',
      'portals.read',
    ],
  },
  {
    code: 'sales_screen_admin',
    name: 'Sales Screen Administrator',
    priority: 55,
    scope: 'organization',
    modules: ['sales_screen'],
    permissions: [
      'sales_screen.read',
      'sales_screen.manage',
      'sales_screen.approve_events',
      'sales_screen.points',
      'sales_screen.announce',
      'reports.read',
    ],
  },
  {
    code: 'read_only',
    name: 'Read Only',
    priority: 90,
    scope: 'organization',
    modules: ['ready', 'offplan'],
    permissions: [
      'contacts.read',
      'leads.read',
      'listings.read',
      'projects.read',
      'units.read',
      'deals.read',
      'reports.read',
      'activities.read',
    ],
  },
]);

/**
 * Fields hidden unless the actor holds the listed permission. Applied by the API
 * serializers so sensitive data never leaves the process for an unauthorized member.
 */
export const PROTECTED_FIELDS = Object.freeze({
  contact: {
    value_raw: 'contacts.view_sensitive',
    value_normalized: 'contacts.view_sensitive',
    identifiers: 'contacts.view_sensitive',
  },
  deal: {
    gross_commission: 'commissions.read',
    net_commission: 'commissions.read',
    commission_percentage: 'commissions.read',
  },
  integration_connection: {
    credentials: 'integrations.manage',
  },
});

export function isPlatformAdmin(actor) {
  return Boolean(actor?.isPlatformAdmin);
}

export function hasPermission(actor, permission) {
  if (!actor) return false;
  if (isPlatformAdmin(actor)) return true;
  return Boolean(actor.permissions?.has?.(permission) ?? actor.permissions?.includes?.(permission));
}

export function hasModule(actor, module) {
  if (!actor) return false;
  if (isPlatformAdmin(actor)) return true;
  if (!module || module === MODULES.ADMIN) return actor.modules?.includes?.(MODULES.ADMIN) ?? false;
  return Boolean(actor.modules?.includes?.(module));
}

/**
 * Central authorization check used by every API operation: module entitlement first,
 * then the permission itself.
 */
export function authorize(actor, permission, { module } = {}) {
  if (!actor) throw new ForbiddenError('No actor in request context');
  if (isPlatformAdmin(actor)) return true;

  const requiredModule = module ?? PERMISSION_MODULE[permission];
  if (requiredModule && !hasModule(actor, requiredModule)) {
    throw new ForbiddenError(`The ${requiredModule} module is not enabled for this user`, {
      permission,
      module: requiredModule,
    });
  }
  if (!hasPermission(actor, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`, { permission });
  }
  return true;
}

/**
 * Describes which records the actor may see. Repositories translate this into SQL; no
 * query ever runs without a tenant predicate.
 */
export function buildRecordScope(actor, { ownerField = 'created_by', assignedField = null } = {}) {
  if (isPlatformAdmin(actor) && actor.organizationId == null) {
    return { type: 'platform' };
  }
  const scope = actor.recordScope ?? 'own';
  const base = { organizationId: actor.organizationId, type: scope };

  switch (scope) {
    case 'organization':
      return base;
    case 'branch':
      return { ...base, branchId: actor.branchId ?? null };
    case 'team':
      return { ...base, teamId: actor.teamId ?? null, membershipId: actor.membershipId };
    case 'assigned':
      return { ...base, membershipId: actor.membershipId, assignedField, ownerField };
    case 'own':
    default:
      return { ...base, membershipId: actor.membershipId, ownerField, assignedField };
  }
}

export function widensScope(current, candidate) {
  return (SCOPE_RANK[candidate] ?? 0) > (SCOPE_RANK[current] ?? 0);
}

/** Highest scope granted by the actor's roles, used when a membership has several roles. */
export function effectiveScope(scopes = []) {
  return scopes.reduce((best, scope) => (widensScope(best, scope) ? scope : best), 'own');
}

export function filterProtectedFields(actor, entityType, record) {
  const rules = PROTECTED_FIELDS[entityType];
  if (!rules || !record) return record;
  const output = { ...record };
  for (const [field, permission] of Object.entries(rules)) {
    if (field in output && !hasPermission(actor, permission)) {
      delete output[field];
    }
  }
  return output;
}
