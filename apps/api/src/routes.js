import { Router } from 'express';
import { getDb } from '@govyzer/database';
import { loadServerConfig } from '@govyzer/config';
import { sendData } from './core/responses.js';
import { authRoutes } from './modules/auth/routes.js';
import { organizationRoutes } from './modules/organizations/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { contactRoutes } from './modules/contacts/routes.js';
import { leadRoutes } from './modules/leads/routes.js';

export function buildRouter() {
  const router = Router();

  router.get('/health', (req, res) => sendData(res, { status: 'ok', time: new Date().toISOString() }));

  router.get('/ready', async (req, res, next) => {
    try {
      await getDb().raw('SELECT 1');
      sendData(res, { status: 'ready', database: 'up' });
    } catch (error) {
      res.status(503).json({ error: { code: 'not_ready', message: 'Database is unavailable' } });
      next();
    }
  });

  router.get('/version', (req, res) => {
    const { env } = loadServerConfig();
    sendData(res, {
      name: 'govyzer-api',
      app_env: env.APP_ENV,
      node: process.version,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      started_at: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    });
  });

  const v1 = Router();
  v1.use('/auth', authRoutes());
  v1.use('/organization', organizationRoutes());
  v1.use('/users', userRoutes());
  v1.use('/contacts', contactRoutes());
  v1.use('/leads', leadRoutes());
  router.use('/v1', v1);

  return router;
}
