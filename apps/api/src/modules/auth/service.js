import bcrypt from 'bcryptjs';
import { getDb, withTransaction } from '@govyzer/database';
import { loadServerConfig } from '@govyzer/config';
import {
  newId,
  newToken,
  UnauthorizedError,
  ValidationError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
} from '@govyzer/domain';
import { sha256, randomToken } from '../../core/crypto.js';
import { signAccessToken, createRefreshToken } from '../../core/tokens.js';
import { loadActorContext } from '../../middleware/auth.js';
import { recordAudit } from '../../core/audit.js';
import { sendMail, renderBrandedEmail } from '../../core/mailer.js';
import { provisionOrganizationDefaults, ensurePlatformCatalogue } from '../organizations/provisioning.js';
import { logger } from '../../core/logger.js';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function createSession({ trx, userId, organizationId, membershipId, request }) {
  const { env } = loadServerConfig();
  const { token, hash } = createRefreshToken();
  const sessionId = newId();
  const familyId = newId();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await trx('sessions').insert({
    id: sessionId,
    user_id: userId,
    organization_id: organizationId ?? '',
    refresh_token_hash: hash,
    family_id: familyId,
    user_agent: request?.userAgent?.slice(0, 300) ?? null,
    ip_address: request?.ip ?? null,
    expires_at: expiresAt,
    last_used_at: trx.fn.now(),
  });

  const accessToken = signAccessToken({
    userId,
    organizationId,
    membershipId,
    sessionId,
    isPlatformAdmin: request?.isPlatformAdmin ?? false,
  });
  return { sessionId, accessToken, refreshToken: token, csrfToken: randomToken(24), expiresAt };
}

async function issueEmailVerification(trx, user, branding = {}) {
  const token = newToken(32);
  await trx('email_verification_tokens').insert({
    id: newId(),
    user_id: user.id,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
  });
  const { env } = loadServerConfig();
  const url = `${env.CRM_PUBLIC_URL}/verify-email?token=${token}`;
  await sendMail({
    to: user.email,
    subject: 'Verify your email address',
    html: renderBrandedEmail({
      branding,
      title: 'Confirm your email',
      bodyHtml: '<p>Confirm your email address to activate your account.</p>',
      actionUrl: url,
      actionLabel: 'Verify email',
    }),
    text: `Verify your email: ${url}`,
  });
  return token;
}

/** Registers the first owner of a brand new organization and provisions its defaults. */
export async function register(payload, request = {}) {
  const db = getDb();
  const existingUser = await db('users').where('email', payload.email).first('id');
  if (existingUser) {
    throw new ConflictError('An account with this email address already exists');
  }
  const existingSlug = await db('organizations').where('slug', payload.organization_slug).first('id');
  if (existingSlug) {
    throw new ValidationError('That workspace address is already taken', [
      { path: 'organization_slug', message: 'Choose a different workspace address' },
    ]);
  }

  const passwordHash = await hashPassword(payload.password);

  const result = await withTransaction(db, async (trx) => {
    await ensurePlatformCatalogue(trx);

    const organization = {
      id: newId(),
      name: payload.organization_name,
      slug: payload.organization_slug,
      status: 'trial',
      country: payload.country,
      default_locale: payload.locale,
      default_currency: payload.currency,
      timezone: payload.timezone,
      reference_prefix: payload.organization_slug.slice(0, 4).toUpperCase(),
      commission_base: 'gross_before_vat',
      trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
    await trx('organizations').insert(organization);

    const user = {
      id: newId(),
      email: payload.email,
      password_hash: passwordHash,
      first_name: payload.first_name,
      last_name: payload.last_name,
      phone: payload.phone ?? null,
      locale: payload.locale,
      timezone: payload.timezone,
      status: 'active',
    };
    await trx('users').insert(user);

    const defaults = await provisionOrganizationDefaults(trx, organization, { modules: payload.modules });

    const membershipId = newId();
    await trx('organization_memberships').insert({
      id: membershipId,
      organization_id: organization.id,
      user_id: user.id,
      branch_id: defaults.branchId,
      job_title: 'Owner',
      status: 'active',
      record_scope: 'organization',
      modules: JSON.stringify([...new Set([...payload.modules, 'finance', 'admin'])]),
      accepted_at: trx.fn.now(),
    });

    const ownerRole = await trx('roles').where({ organization_id: '', code: 'org_owner' }).first('id');
    await trx('membership_roles').insert({ membership_id: membershipId, role_id: ownerRole.id });

    await issueEmailVerification(trx, user, { company_display_name: organization.name });

    const session = await createSession({
      trx,
      userId: user.id,
      organizationId: organization.id,
      membershipId,
      request,
    });

    await recordAudit({
      organizationId: organization.id,
      actor: { userId: user.id, membershipId },
      action: 'organization.registered',
      entityType: 'organization',
      entityId: organization.id,
      after: { name: organization.name, slug: organization.slug },
      requestId: request.requestId,
      ipAddress: request.ip,
      userAgent: request.userAgent,
      trx,
    });

    return { organization, user, membershipId, session };
  });

  const actor = await loadActorContext({
    userId: result.user.id,
    organizationId: result.organization.id,
    membershipId: result.membershipId,
    sessionId: result.session.sessionId,
  });
  return { actor, session: result.session };
}

export async function login(payload, request = {}) {
  const db = getDb();
  const user = await db('users').where('email', payload.email).whereNull('deleted_at').first();

  // Constant-ish work whether or not the user exists, so timing does not leak accounts.
  const hash = user?.password_hash ?? '$2a$12$............................................';
  const passwordMatches = await bcrypt.compare(payload.password, hash).catch(() => false);

  if (!user || !passwordMatches) {
    if (user) {
      const attempts = Number(user.failed_login_attempts ?? 0) + 1;
      await db('users')
        .where('id', user.id)
        .update({
          failed_login_attempts: attempts,
          locked_until: attempts >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        });
    }
    throw new UnauthorizedError('Email address or password is incorrect');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new UnauthorizedError('This account is temporarily locked. Try again shortly.');
  }
  if (user.status !== 'active') throw new UnauthorizedError('Your account is not active');

  const memberships = await db('organization_memberships')
    .join('organizations', 'organizations.id', 'organization_memberships.organization_id')
    .where('organization_memberships.user_id', user.id)
    .where('organization_memberships.status', 'active')
    .whereNull('organization_memberships.deleted_at')
    .whereNull('organizations.deleted_at')
    .select(
      'organization_memberships.id as membership_id',
      'organizations.id as organization_id',
      'organizations.name as organization_name',
      'organizations.slug as organization_slug'
    );

  if (memberships.length === 0 && !user.is_platform_admin) {
    throw new ForbiddenError('Your account is not linked to an active organization');
  }

  const selected = payload.organization_id
    ? memberships.find((membership) => membership.organization_id === payload.organization_id)
    : memberships[0];

  if (payload.organization_id && !selected) {
    throw new ForbiddenError('You are not a member of that organization');
  }

  const session = await withTransaction(db, async (trx) => {
    await trx('users')
      .where('id', user.id)
      .update({ failed_login_attempts: 0, locked_until: null, last_login_at: trx.fn.now() });
    return createSession({
      trx,
      userId: user.id,
      organizationId: selected?.organization_id ?? null,
      membershipId: selected?.membership_id ?? null,
      request: { ...request, isPlatformAdmin: Boolean(user.is_platform_admin) },
    });
  });

  await recordAudit({
    organizationId: selected?.organization_id ?? '',
    actor: { userId: user.id, membershipId: selected?.membership_id ?? null },
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    requestId: request.requestId,
    ipAddress: request.ip,
    userAgent: request.userAgent,
  });

  const actor = await loadActorContext({
    userId: user.id,
    organizationId: selected?.organization_id ?? null,
    membershipId: selected?.membership_id ?? null,
    sessionId: session.sessionId,
  });
  return { actor, session, memberships };
}

/** Rotates the refresh session. A reused token revokes the whole family. */
export async function refresh(refreshToken, request = {}) {
  if (!refreshToken) throw new UnauthorizedError('A refresh token is required');
  const db = getDb();
  const hash = sha256(refreshToken);
  const session = await db('sessions').where('refresh_token_hash', hash).first();

  if (!session) throw new UnauthorizedError('Invalid refresh token');
  if (session.revoked_at) {
    await db('sessions')
      .where('family_id', session.family_id)
      .whereNull('revoked_at')
      .update({ revoked_at: db.fn.now(), revoked_reason: 'token_reuse_detected' });
    logger.warn('refresh_token_reuse', { session_id: session.id, user_id: session.user_id });
    throw new UnauthorizedError('This session has been revoked');
  }
  if (new Date(session.expires_at) < new Date()) throw new UnauthorizedError('Your session has expired');

  const membership = session.organization_id
    ? await db('organization_memberships')
        .where({ organization_id: session.organization_id, user_id: session.user_id })
        .whereNull('deleted_at')
        .first('id')
    : null;

  const rotated = await withTransaction(db, async (trx) => {
    const { token, hash: nextHash } = createRefreshToken();
    const { env } = loadServerConfig();
    const newSessionId = newId();

    await trx('sessions').where('id', session.id).update({
      revoked_at: trx.fn.now(),
      revoked_reason: 'rotated',
      last_used_at: trx.fn.now(),
    });
    await trx('sessions').insert({
      id: newSessionId,
      user_id: session.user_id,
      organization_id: session.organization_id,
      refresh_token_hash: nextHash,
      family_id: session.family_id,
      rotated_from: session.id,
      user_agent: request?.userAgent?.slice(0, 300) ?? session.user_agent,
      ip_address: request?.ip ?? session.ip_address,
      expires_at: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
      last_used_at: trx.fn.now(),
    });

    const user = await trx('users').where('id', session.user_id).first('is_platform_admin');
    return {
      sessionId: newSessionId,
      refreshToken: token,
      csrfToken: randomToken(24),
      accessToken: signAccessToken({
        userId: session.user_id,
        organizationId: session.organization_id || null,
        membershipId: membership?.id ?? null,
        sessionId: newSessionId,
        isPlatformAdmin: Boolean(user?.is_platform_admin),
      }),
    };
  });

  const actor = await loadActorContext({
    userId: session.user_id,
    organizationId: session.organization_id || null,
    membershipId: membership?.id ?? null,
    sessionId: rotated.sessionId,
  });
  return { actor, session: rotated };
}

export async function logout(sessionId, { allDevices = false } = {}) {
  const db = getDb();
  if (!sessionId) return true;
  const session = await db('sessions').where('id', sessionId).first();
  if (!session) return true;

  const query = allDevices
    ? db('sessions').where('user_id', session.user_id)
    : db('sessions').where('id', sessionId);
  await query.whereNull('revoked_at').update({
    revoked_at: db.fn.now(),
    revoked_reason: allDevices ? 'logout_all' : 'logout',
  });
  return true;
}

export async function switchOrganization({ userId, organizationId, sessionId, request = {} }) {
  const db = getDb();
  const membership = await db('organization_memberships')
    .where({ user_id: userId, organization_id: organizationId, status: 'active' })
    .whereNull('deleted_at')
    .first();
  if (!membership) throw new ForbiddenError('You are not a member of that organization');

  await logout(sessionId);
  const user = await db('users').where('id', userId).first();
  const session = await withTransaction(db, (trx) =>
    createSession({
      trx,
      userId,
      organizationId,
      membershipId: membership.id,
      request: { ...request, isPlatformAdmin: Boolean(user.is_platform_admin) },
    })
  );
  const actor = await loadActorContext({
    userId,
    organizationId,
    membershipId: membership.id,
    sessionId: session.sessionId,
  });
  return { actor, session };
}

export async function requestPasswordReset(email, request = {}) {
  const db = getDb();
  const user = await db('users').where('email', email).whereNull('deleted_at').first();
  // Always return success so the endpoint cannot be used to enumerate accounts.
  if (!user) return { requested: true };

  const token = newToken(32);
  await db('password_reset_tokens').insert({
    id: newId(),
    user_id: user.id,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
  });
  const { env } = loadServerConfig();
  const url = `${env.CRM_PUBLIC_URL}/reset-password?token=${token}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your password',
    html: renderBrandedEmail({
      title: 'Reset your password',
      bodyHtml: '<p>Use the button below to choose a new password. The link expires in one hour.</p>',
      actionUrl: url,
      actionLabel: 'Reset password',
    }),
    text: `Reset your password: ${url}`,
  });
  await recordAudit({
    actor: { userId: user.id },
    action: 'auth.password_reset_requested',
    entityType: 'user',
    entityId: user.id,
    requestId: request.requestId,
    ipAddress: request.ip,
  });
  return { requested: true };
}

export async function resetPassword({ token, password }, request = {}) {
  const db = getDb();
  const record = await db('password_reset_tokens').where('token_hash', sha256(token)).first();
  if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
    throw new ValidationError('This password reset link is invalid or has expired');
  }
  const passwordHash = await hashPassword(password);

  await withTransaction(db, async (trx) => {
    await trx('users').where('id', record.user_id).update({
      password_hash: passwordHash,
      failed_login_attempts: 0,
      locked_until: null,
      updated_at: trx.fn.now(),
    });
    await trx('password_reset_tokens').where('id', record.id).update({ used_at: trx.fn.now() });
    await trx('sessions')
      .where('user_id', record.user_id)
      .whereNull('revoked_at')
      .update({ revoked_at: trx.fn.now(), revoked_reason: 'password_reset' });
  });

  await recordAudit({
    actor: { userId: record.user_id },
    action: 'auth.password_reset',
    entityType: 'user',
    entityId: record.user_id,
    requestId: request.requestId,
    ipAddress: request.ip,
  });
  return { reset: true };
}

export async function verifyEmail(token) {
  const db = getDb();
  const record = await db('email_verification_tokens').where('token_hash', sha256(token)).first();
  if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
    throw new ValidationError('This verification link is invalid or has expired');
  }
  await withTransaction(db, async (trx) => {
    await trx('users').where('id', record.user_id).update({ email_verified_at: trx.fn.now() });
    await trx('email_verification_tokens').where('id', record.id).update({ used_at: trx.fn.now() });
  });
  return { verified: true };
}

export async function createInvitation({ organizationId, actor, payload }) {
  const db = getDb();
  const existing = await db('organization_memberships')
    .join('users', 'users.id', 'organization_memberships.user_id')
    .where('organization_memberships.organization_id', organizationId)
    .where('users.email', payload.email)
    .whereNull('organization_memberships.deleted_at')
    .first('organization_memberships.id');
  if (existing) throw new ConflictError('That person is already a member of this organization');

  const roles = await db('roles')
    .whereIn('code', payload.role_codes)
    .where((builder) => builder.where('organization_id', organizationId).orWhere('organization_id', ''))
    .select('id', 'code');
  if (roles.length === 0) throw new ValidationError('No valid roles were supplied', [{ path: 'role_codes', message: 'Unknown role' }]);

  const token = newToken(32);
  const invitationId = newId();
  await db('invitations').insert({
    id: invitationId,
    organization_id: organizationId,
    email: payload.email,
    token_hash: sha256(token),
    role_ids: JSON.stringify(roles.map((role) => role.id)),
    modules: JSON.stringify(payload.modules),
    branch_id: payload.branch_id ?? null,
    team_id: payload.team_id ?? null,
    job_title: payload.job_title ?? null,
    status: 'pending',
    invited_by: actor.membershipId,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  const branding = await db('organization_branding').where('organization_id', organizationId).first();
  const organization = await db('organizations').where('id', organizationId).first('name');
  const { env } = loadServerConfig();
  const url = `${env.CRM_PUBLIC_URL}/accept-invite?token=${token}`;
  await sendMail({
    to: payload.email,
    subject: `You have been invited to ${organization.name}`,
    html: renderBrandedEmail({
      branding: branding ?? {},
      title: `Join ${organization.name}`,
      bodyHtml: `<p>${actor.firstName ?? 'A colleague'} invited you to join ${organization.name} on Govyzer.</p>`,
      actionUrl: url,
      actionLabel: 'Accept invitation',
    }),
    text: `Accept your invitation: ${url}`,
  });

  await recordAudit({
    organizationId,
    actor,
    action: 'user.invited',
    entityType: 'invitation',
    entityId: invitationId,
    after: { email: payload.email, roles: payload.role_codes },
  });
  return { id: invitationId, email: payload.email, expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };
}

export async function acceptInvitation(payload, request = {}) {
  const db = getDb();
  const invitation = await db('invitations').where('token_hash', sha256(payload.token)).first();
  if (!invitation || invitation.status !== 'pending' || new Date(invitation.expires_at) < new Date()) {
    throw new ValidationError('This invitation is invalid or has expired');
  }

  const result = await withTransaction(db, async (trx) => {
    let user = await trx('users').where('email', invitation.email).first();
    if (!user) {
      if (!payload.password || !payload.first_name || !payload.last_name) {
        throw new ValidationError('First name, last name and a password are required to create your account', [
          { path: 'password', message: 'Required for a new account' },
        ]);
      }
      const id = newId();
      await trx('users').insert({
        id,
        email: invitation.email,
        password_hash: await hashPassword(payload.password),
        first_name: payload.first_name,
        last_name: payload.last_name,
        status: 'active',
        email_verified_at: trx.fn.now(),
      });
      user = await trx('users').where('id', id).first();
    }

    const membershipId = newId();
    await trx('organization_memberships').insert({
      id: membershipId,
      organization_id: invitation.organization_id,
      user_id: user.id,
      branch_id: invitation.branch_id,
      team_id: invitation.team_id,
      job_title: invitation.job_title,
      status: 'active',
      record_scope: 'assigned',
      modules: invitation.modules ?? JSON.stringify(['ready']),
      invited_by: invitation.invited_by,
      invited_at: invitation.created_at,
      accepted_at: trx.fn.now(),
    });

    const roleIds = typeof invitation.role_ids === 'string' ? JSON.parse(invitation.role_ids) : invitation.role_ids;
    await trx('membership_roles').insert(roleIds.map((roleId) => ({ membership_id: membershipId, role_id: roleId })));
    await trx('invitations').where('id', invitation.id).update({ status: 'accepted', accepted_at: trx.fn.now() });

    const session = await createSession({
      trx,
      userId: user.id,
      organizationId: invitation.organization_id,
      membershipId,
      request,
    });
    return { user, membershipId, session };
  });

  const actor = await loadActorContext({
    userId: result.user.id,
    organizationId: invitation.organization_id,
    membershipId: result.membershipId,
    sessionId: result.session.sessionId,
  });
  return { actor, session: result.session };
}

export async function listSessions(userId) {
  const db = getDb();
  return db('sessions')
    .where('user_id', userId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .select('id', 'organization_id', 'user_agent', 'ip_address', 'created_at', 'last_used_at', 'expires_at', 'revoked_at');
}

export async function revokeSession(userId, sessionId) {
  const db = getDb();
  const updated = await db('sessions')
    .where({ id: sessionId, user_id: userId })
    .whereNull('revoked_at')
    .update({ revoked_at: db.fn.now(), revoked_reason: 'revoked_by_user' });
  if (updated === 0) throw new NotFoundError('Session');
  return true;
}

export function serializeActor(actor) {
  if (!actor) return null;
  return {
    user: {
      id: actor.userId,
      email: actor.email,
      first_name: actor.firstName ?? null,
      last_name: actor.lastName ?? null,
      locale: actor.locale ?? 'en',
      is_platform_admin: actor.isPlatformAdmin,
    },
    organization: actor.organizationId
      ? {
          id: actor.organizationId,
          slug: actor.organizationSlug,
          timezone: actor.organizationTimezone,
          currency: actor.organizationCurrency,
          vat_percentage: actor.vatPercentage,
          plan_code: actor.planCode,
        }
      : null,
    membership: actor.membershipId
      ? {
          id: actor.membershipId,
          branch_id: actor.branchId,
          team_id: actor.teamId,
          record_scope: actor.recordScope,
          roles: actor.roles ?? [],
        }
      : null,
    permissions: [...(actor.permissions ?? [])].sort(),
    modules: actor.modules ?? [],
    limits: actor.limits ?? {},
  };
}
