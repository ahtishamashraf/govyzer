import { Router } from 'express';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  inviteSchema,
  acceptInviteSchema,
  switchOrganizationSchema,
} from '@govyzer/validation';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requirePermission, requireOrganization } from '../../middleware/auth.js';
import { rateLimit } from '../../core/rate-limit.js';
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from '../../core/cookies.js';
import { sendData, sendNoContent } from '../../core/responses.js';
import { loadServerConfig } from '@govyzer/config';
import * as service from './service.js';

const authLimiter = () => {
  const { env } = loadServerConfig();
  return rateLimit({
    name: 'auth',
    max: env.AUTH_RATE_LIMIT_MAX,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    keyResolver: (req) => `${req.ip}:${req.body?.email ?? ''}`,
  });
};

function requestMeta(req) {
  return { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId };
}

export function authRoutes() {
  const router = Router();

  router.post('/register', authLimiter(), validate({ body: registerSchema }), async (req, res, next) => {
    try {
      const { actor, session } = await service.register(req.validatedBody, requestMeta(req));
      setAuthCookies(res, session);
      sendData(res, { ...service.serializeActor(actor), access_token: session.accessToken, csrf_token: session.csrfToken }, { status: 201 });
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', authLimiter(), validate({ body: loginSchema }), async (req, res, next) => {
    try {
      const { actor, session, memberships } = await service.login(req.validatedBody, requestMeta(req));
      setAuthCookies(res, session);
      sendData(res, {
        ...service.serializeActor(actor),
        access_token: session.accessToken,
        csrf_token: session.csrfToken,
        organizations: memberships.map((membership) => ({
          id: membership.organization_id,
          name: membership.organization_name,
          slug: membership.organization_slug,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/refresh', authLimiter(), async (req, res, next) => {
    try {
      const token = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refresh_token;
      const { actor, session } = await service.refresh(token, requestMeta(req));
      setAuthCookies(res, session);
      sendData(res, { ...service.serializeActor(actor), access_token: session.accessToken, csrf_token: session.csrfToken });
    } catch (error) {
      clearAuthCookies(res);
      next(error);
    }
  });

  router.post('/logout', authenticate({ optional: true }), async (req, res, next) => {
    try {
      await service.logout(req.actor?.sessionId, { allDevices: req.body?.all_devices === true });
      clearAuthCookies(res);
      sendNoContent(res);
    } catch (error) {
      next(error);
    }
  });

  router.post('/forgot-password', authLimiter(), validate({ body: forgotPasswordSchema }), async (req, res, next) => {
    try {
      await service.requestPasswordReset(req.validatedBody.email, requestMeta(req));
      sendData(res, { requested: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/reset-password', authLimiter(), validate({ body: resetPasswordSchema }), async (req, res, next) => {
    try {
      sendData(res, await service.resetPassword(req.validatedBody, requestMeta(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/verify-email', validate({ body: verifyEmailSchema }), async (req, res, next) => {
    try {
      sendData(res, await service.verifyEmail(req.validatedBody.token));
    } catch (error) {
      next(error);
    }
  });

  router.post('/accept-invite', authLimiter(), validate({ body: acceptInviteSchema }), async (req, res, next) => {
    try {
      const { actor, session } = await service.acceptInvitation(req.validatedBody, requestMeta(req));
      setAuthCookies(res, session);
      sendData(res, { ...service.serializeActor(actor), access_token: session.accessToken, csrf_token: session.csrfToken }, { status: 201 });
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', authenticate(), requireAuth(), async (req, res, next) => {
    try {
      const db = getDb();
      const organizations = await db('organization_memberships')
        .join('organizations', 'organizations.id', 'organization_memberships.organization_id')
        .where('organization_memberships.user_id', req.actor.userId)
        .where('organization_memberships.status', 'active')
        .whereNull('organization_memberships.deleted_at')
        .select('organizations.id', 'organizations.name', 'organizations.slug');
      sendData(res, { ...service.serializeActor(req.actor), organizations });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/switch-organization',
    authenticate(),
    requireAuth(),
    validate({ body: switchOrganizationSchema }),
    async (req, res, next) => {
      try {
        const { actor, session } = await service.switchOrganization({
          userId: req.actor.userId,
          organizationId: req.validatedBody.organization_id,
          sessionId: req.actor.sessionId,
          request: requestMeta(req),
        });
        setAuthCookies(res, session);
        sendData(res, { ...service.serializeActor(actor), access_token: session.accessToken, csrf_token: session.csrfToken });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get('/sessions', authenticate(), requireAuth(), async (req, res, next) => {
    try {
      sendData(res, await service.listSessions(req.actor.userId));
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    '/sessions/:id',
    authenticate(),
    requireAuth(),
    validate({ params: z.object({ id: z.string().length(26) }) }),
    async (req, res, next) => {
      try {
        await service.revokeSession(req.actor.userId, req.validatedParams.id);
        sendNoContent(res);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/invitations',
    authenticate(),
    requireAuth(),
    requireOrganization(),
    requirePermission('users.invite'),
    validate({ body: inviteSchema }),
    async (req, res, next) => {
      try {
        const invitation = await service.createInvitation({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          payload: req.validatedBody,
        });
        sendData(res, invitation, { status: 201 });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/invitations',
    authenticate(),
    requireAuth(),
    requireOrganization(),
    requirePermission('users.read'),
    async (req, res, next) => {
      try {
        const rows = await getDb()('invitations')
          .where('organization_id', req.actor.organizationId)
          .orderBy('created_at', 'desc')
          .limit(100)
          .select('id', 'email', 'status', 'job_title', 'expires_at', 'accepted_at', 'created_at');
        sendData(res, rows);
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}
