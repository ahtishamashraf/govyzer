import express from 'express';
import cookieParser from 'cookie-parser';
import { loadServerConfig } from '@govyzer/config';
import { requestContext } from './core/context.js';
import { corsMiddleware, securityHeaders } from './middleware/security.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { logger } from './core/logger.js';
import { buildRouter } from './routes.js';
import './jobs/index.js';
import './jobs/handlers.js';

export function createApp({ extraCorsOrigins = [] } = {}) {
  const config = loadServerConfig();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders());
  app.use(corsMiddleware(extraCorsOrigins));
  app.use(requestContext());
  app.use(cookieParser());

  // Raw body is preserved for webhook signature verification.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, res, buffer) => {
        if (req.path.startsWith('/v1/webhooks')) req.rawBody = buffer.toString('utf8');
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(csrfProtection());

  app.use((req, res, next) => {
    res.on('finish', () => {
      const durationMs = Date.now() - (req.startedAt ?? Date.now());
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: durationMs,
        request_id: req.requestId,
        organization_id: req.actor?.organizationId ?? null,
      });
    });
    next();
  });

  app.use(buildRouter());
  app.use(notFoundHandler());
  app.use(errorHandler());

  logger.debug('api_ready', { app_env: config.env.APP_ENV });
  return app;
}

export default createApp;
