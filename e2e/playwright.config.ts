import { defineConfig, devices } from '@playwright/test';

// browser.newContext() (the context @playwright/test automatically hands each test)
// defaults to incognito mode (a disposable profile without persistent
// cookies/localStorage/history).
// Don't use launchPersistentContext() here: that would give a persistent profile,
// breaking the incognito-only assumption.

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { outputFolder: '../.cache/playwright-report', open: 'never' }]],
  outputDir: '../.cache/playwright-test-results',
  use: {
    // Must match e2e/vite.config.ts's server.port.
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    // The root ("/") has no index.html and 404s, so startup completion is judged
    // against a fixture that actually exists.
    // Without an explicit cwd, webServer defaults to this config file's own directory (e2e/).
    command: 'npm run dev:e2e',
    cwd: '..',
    url: 'http://localhost:5174/fixtures/scenario.html',
    reuseExistingServer: !process.env.CI,
  },
});
