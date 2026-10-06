import { defineConfig } from '@playwright/test';

const localAuthEnabled = process.env.E2E_LOCAL_AUTH === 'true';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  ...(localAuthEnabled
    ? {
        webServer: {
          command: 'npm run dev',
          url: `${baseURL}/login`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }
    : {}),
});
