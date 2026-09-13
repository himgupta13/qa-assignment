import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'api',
      testDir: './tests/api',
      // Running this live against docker-compose surfaced real cross-test contamination:
      // flagd's config is one global, shared, mutable resource for the whole running app
      // (not scoped per test, per file, or per worker), so a parallel worker toggling
      // paymentFailure/productCatalogFailure could flip it out from under an unrelated
      // request another worker was mid-flight on — observed live as TC-CO-01 (no flags
      // involved) getting a stray 422 PAYMENT_FAILED because a concurrent worker had
      // paymentFailure on at that instant. Serializing this project trades suite speed
      // for correctness against real shared external state — see automation-strategy.md
      // "Flakiness" for the reasoning and why this generalizes beyond this one suite.
      fullyParallel: false,
      workers: 1,
    },
    {
      name: 'e2e-chromium',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
