// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright config for the Command Center E2E suite.
 * A static server is expected at http://localhost:8000. If it isn't running,
 * the webServer block below will start one (npx serve) and reuse an existing one.
 */
module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8000',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx --yes serve -l 8000 .',
    url: 'http://localhost:8000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
