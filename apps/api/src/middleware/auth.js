import { getDb } from '@govyzer/database';
import {
  UnauthorizedError,
  ForbiddenError,
  authorize,
  effectiveScope,
  hasModule,
} from '@govyzer/domain';
import { ACCESS_COOKIE } from '../core/cookies.js';
import { verifyAccessToken, verifyDisplayToken } from '../core/tokens.js';
import { sha256 } from '../core/crypto.js';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Loads the full authorization context for a membership: roles, permissions, module
 * entitlements (intersected with the organization's subscription) and record scope.
 */
export async function loadActorContext({ userId, organizationId, membershipId, sessionId, db = getDb() }) {
  const user = await db('users').where('id', userId).whereNull('deleted_at').first();
  if (!user || user.status !== 'active') throw new UnauthorizedError('Your account is not active');

  if (!organizationId) {
    return {
      type: 'user',
      userId: user.id,
      email: user.email,
      isPlatformAdmin: Boolean(user.is_platform_admin),
      organizationId: null,
      membershipId: null,
      permissions: new Set(),
      modules: [],
      recordScope: 'own',
      sessionId,
      locale: user.locale,
    };
  }

  const membership = await db('organization_memberships')
    .where('id', membershipId)
    .where('organization_id', organizationId)
    .whereNull('deleted_at')
    .first();
  if (!membership || membership.status !== 'active') {
    throw new ForbiddenError('Your membership in this organization is not active');
  }

  const organization = await db('organizations').where('id', organizationId).whereNull('deleted_at').first();
  if (!organization || organization.status === 'suspended') {
    throw new ForbiddenError('This organization is not active');
  }

  const roles = await db('membership_roles')
    .join('roles', 'roles.id', 'membership_roles.role_id')
    .where('membership_roles.membership_id', membership.id)
    .select('roles.id', 'roles.code', 'roles.name');

  const permissions = new Set(
    (
      await db('role_permissions')
        .join('permissions', 'permissions.id', 'role_permissions.permission_id')
        .whereIn(
          'role_permissions.role_id',
          roles.map((role) => role.id)
        )
        .pluck('permissions.code')
    ).filter(Boolean)
  );

  const subscription = await db('organization_subscriptions')
    .leftJoin('subscription_plans', 'subscription_plans.id', 'organization_subscriptions.plan_id')
    .where('organization_subscriptions.organization_id', organizationId)
    .whereNull('organization_subscriptions.deleted_at')
    .orderBy('organization_subscriptions.created_at', 'desc')
    .first(
      'organization_subscriptions.modules_override',
      'organization_subscriptions.limits_override',
      'subscription_plans.modules as plan_modules',
      'subscription_plans.limits as plan_limits',
      'subscription_plans.code as plan_code'
    );

  const planModules = parseJson(subscription?.modules_override, null) ?? parseJson(subscription?.plan_modules, null);
  const membershipModules = parseJson(membership.modules, []) ?? [];
  const modules = Array.isArray(planModules)
    ? membershipModules.filter((module) => planModules.includes(module))
    : membershipModules;

  return {
    type: 'user',
    userId: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    locale: user.locale,
    isPlatformAdmin: Boolean(user.is_platform_admin),
    organizationId,
    organizationSlug: organization.slug,
    organizationTimezone: organization.timezone,
    organizationCurrency: organization.default_currency,
    vatPercentage: Number(organization.vat_percentage ?? 5),
    commissionBase: organization.commission_base,
    referencePrefix: organization.reference_prefix,
    membershipId: membership.id,
    branchId: membership.branch_id,
    teamId: membership.team_id,
    managerMembershipId: membership.manager_membership_id,
    roles: roles.map((role) => role.code),
    permissions,
    modules,
    planCode: subscription?.plan_code ?? null,
    limits: parseJson(subscription?.limits_override, null) ?? parseJson(subscription?.plan_limits, {}) ?? {},
    recordScope: effectiveScope([membership.record_scope]),
    sessionId,
  };
}

/** Resolves the actor from a session cookie, bearer token or tenant API key. */
export function authenticate({ optional = false } = {}) {
  return async (req, res, next) => {
    try {
      const db = getDb();
      const apiKey = req.get('x-api-key');

      if (apiKey) {
        const prefix = apiKey.slice(0, 12);
        const record = await db('api_keys')
          .where('prefix', prefix)
          .where('key_hash', sha256(apiKey))
          .whereNull('revoked_at')
          .first();
        if (!record) throw new UnauthorizedError('Invalid API key');
        if (record.expires_at && new Date(record.expires_at) < new Date()) {
          throw new UnauthorizedError('This API key has expired');
        }
        await db('api_keys').where('id', record.id).update({ last_used_at: db.fn.now() });

        const scopes = parseJson(record.scopes, []) ?? [];
        req.actor = {
          type: 'api_key',
          apiKeyId: record.id,
          organizationId: record.organization_id,
          userId: null,
          membershipId: null,
          isPlatformAdmin: false,
          permissions: new Set(scopes),
          modules: ['ready', 'offplan', 'sales_screen'],
          recordScope: 'organization',
        };
        return next();
      }

      const header = req.get('authorization');
      const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.[ACCESS_COOKIE];
      if (!token) {
        if (optional) return next();
        throw new UnauthorizedError('Authentication is required');
      }

      let payload;
      try {
        payload = verifyAccessToken(token);
      } catch (error) {
        if (optional) return next();
        throw new UnauthorizedError(
          error?.name === 'TokenExpiredError' ? 'Your session has expired' : 'Invalid access token'
        );
      }

      const session = await db('sessions').where('id', payload.sid).first();
      if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
        throw new UnauthorizedError('Your session is no longer valid');
      }

      req.actor = await loadActorContext({
        userId: payload.sub,
        organizationId: payload.org,
        membershipId: payload.mem,
        sessionId: payload.sid,
        db,
      });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** Display sessions can only read their own approved feed and post heartbeats. */
export function authenticateDisplay() {
  return async (req, res, next) => {
    try {
      const header = req.get('authorization');
      const token = req.get('x-display-token') ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);
      if (!token) throw new UnauthorizedError('Display token is required');

      let payload;
      try {
        payload = verifyDisplayToken(token);
      } catch {
        throw new UnauthorizedError('Invalid display token');
      }

      const db = getDb();
      const session = await db('display_sessions')
        .where('id', payload.sid)
        .where('token_hash', sha256(token))
        .first();
      if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
        throw new UnauthorizedError('This display session has been revoked');
      }
      const display = await db('sales_displays')
        .where('id', session.display_id)
        .whereNull('deleted_at')
        .first();
      if (!display || display.revoked_at || display.status === 'revoked') {
        throw new UnauthorizedError('This display has been revoked');
      }

      req.display = display;
      req.displaySession = session;
      req.actor = {
        type: 'display',
        organizationId: display.organization_id,
        displayId: display.id,
        userId: null,
        membershipId: null,
        isPlatformAdmin: false,
        permissions: new Set(['sales_screen.feed']),
        modules: ['sales_screen'],
        recordScope: 'organization',
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireAuth() {
  return (req, res, next) => {
    if (!req.actor) return next(new UnauthorizedError('Authentication is required'));
    return next();
  };
}

export function requireOrganization() {
  return (req, res, next) => {
    if (!req.actor?.organizationId) {
      return next(new ForbiddenError('Select an organization before performing this action'));
    }
    return next();
  };
}

export function requirePlatformAdmin() {
  return (req, res, next) => {
    if (!req.actor?.isPlatformAdmin) return next(new ForbiddenError('Platform administrator access is required'));
    return next();
  };
}

/** Central authorization gate used by every protected route. */
export function requirePermission(permission, options = {}) {
  return (req, res, next) => {
    try {
      if (!req.actor) throw new UnauthorizedError('Authentication is required');
      authorize(req.actor, permission, options);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireModule(module) {
  return (req, res, next) => {
    if (!hasModule(req.actor, module)) {
      return next(new ForbiddenError(`The ${module} module is not enabled for this user`));
    }
    return next();
  };
}

export function requireAnyPermission(permissions) {
  return (req, res, next) => {
    if (!req.actor) return next(new UnauthorizedError('Authentication is required'));
    if (req.actor.isPlatformAdmin) return next();
    const granted = permissions.some((permission) => req.actor.permissions?.has(permission));
    if (!granted) return next(new ForbiddenError(`One of these permissions is required: ${permissions.join(', ')}`));
    return next();
  };
}
