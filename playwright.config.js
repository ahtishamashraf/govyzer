import { defineConfig, devices } from '@playwright/test';

const API_PORT = 4300;
const CRM_PORT = 3300;
const SCREEN_PORT = 3400;

const sharedEnv = {
  NODE_ENV: 'production',
  APP_ENV: 'local',
  DATABASE_HOST: process.env.DATABASE_HOST ?? '127.0.0.1',
  DATABASE_PORT: process.env.DATABASE_PORT ?? '3306',
  DATABASE_USER: process.env.DATABASE_USER ?? 'govyzer',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD ?? '',
  DATABASE_NAME: process.env.E2E_DATABASE_NAME ?? 'govyzer_test',
  LOG_LEVEL: 'warn',
  MAIL_DRIVER: 'log',
  AI_ENABLED: 'false',
  JWT_ACCESS_SECRET: 'e2e-access-secret-value-000000',
  ENCRYPTION_KEYS: process.env.ENCRYPTION_KEYS ?? 'v1:5S6jUHn5IKps4KaDVI4NriUs//1Gox6k1YbXsOfcOrw=',
  ENCRYPTION_ACTIVE_KEY: 'v1',
  CRON_SECRET: 'e2e-cron-secret-value',
  INTERNAL_API_TOKEN: 'e2e-internal-token-value',
  CORS_ALLOWED_ORIGINS: `http://localhost:${CRM_PORT},http://localhost:${SCREEN_PORT}`,
  API_PUBLIC_URL: `http://localhost:${API_PORT}`,
  CRM_PUBLIC_URL: `http://localhost:${CRM_PORT}`,
  SALES_SCREEN_PUBLIC_URL: `http://localhost:${SCREEN_PORT}`,
};

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${CRM_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node apps/api/src/server.js',
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...sharedEnv, PORT: String(API_PORT) },
    },
    {
      command: `npx next start -p ${CRM_PORT}`,
      cwd: './apps/crm-web',
      port: CRM_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...sharedEnv, API_INTERNAL_URL: `http://localhost:${API_PORT}` },
    },
    {
      command: `npx next start -p ${SCREEN_PORT}`,
      cwd: './apps/sales-screen',
      port: SCREEN_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...sharedEnv, API_INTERNAL_URL: `http://localhost:${API_PORT}` },
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The runner image ships Chromium at a fixed path; use it instead of downloading.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],
});

export const PORTS = { API_PORT, CRM_PORT, SCREEN_PORT };
