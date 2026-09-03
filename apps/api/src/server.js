import { loadServerConfig } from '@govyzer/config';
import { createApp } from './app.js';
import { logger } from './core/logger.js';

const { env } = loadServerConfig();
const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('api_listening', { port: env.PORT, app_env: env.APP_ENV });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info('api_shutdown', { signal });
    server.close(() => process.exit(0));
  });
}
