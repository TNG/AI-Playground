import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e-real',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-e2e' }]],
  timeout: 5 * 60_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite --mode test --port 25413',
    url: 'http://127.0.0.1:25413',
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      VITE_DEBUG_TOOLS: 'true',
      VITE_PLATFORM_TITLE: 'from Intel®',
    },
  },
})
