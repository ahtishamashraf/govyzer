import process from 'node:process';

// Tests always run against the disposable test database, never a developer's dev data.
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'local';
process.env.DATABASE_NAME = process.env.TEST_DATABASE_NAME ?? 'govyzer_test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.MAIL_DRIVER = 'log';
process.env.AI_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';
process.env.CRON_SECRET = process.env.CRON_SECRET ?? 'test-cron-secret-value';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN ?? 'test-internal-token-value';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-value-000000';
process.env.ENCRYPTION_KEYS = process.env.ENCRYPTION_KEYS ?? 'v1:5S6jUHn5IKps4KaDVI4NriUs//1Gox6k1YbXsOfcOrw=';
process.env.ENCRYPTION_ACTIVE_KEY = 'v1';
