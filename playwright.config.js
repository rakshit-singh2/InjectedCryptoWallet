import { defineConfig } from '@playwright/test';

// Extension tests need a persistent context with the unpacked build loaded, so each project
// only selects a browser; tests/e2e/fixtures.js does the launching. Branded Google Chrome
// (137+) ignores --load-extension, so it is expected to report "extension did not load".
// Edge and Brave run only when installed; WebKit cannot load Chromium extensions at all,
// and Safari Web Extension packaging must be validated in real Safari.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  // Per-action timeout so a hung step fails with its location instead of the whole-test timeout.
  use: { actionTimeout: 15_000, navigationTimeout: 15_000 },
  expect: { timeout: 10_000 },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        channel: 'chromium',
        // Optional: reuse an already-installed Chromium instead of `npx playwright install chromium`.
        ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : {}),
      },
    },
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
    { name: 'msedge', use: { browserName: 'chromium', channel: 'msedge' } },
    ...(process.env.BRAVE_PATH
      ? [{ name: 'brave', use: { browserName: 'chromium', launchOptions: { executablePath: process.env.BRAVE_PATH } } }]
      : []),
  ],
});
