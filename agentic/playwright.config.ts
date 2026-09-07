import { defineConfig } from '@playwright/test';

// API-only project — no browser project needed, so this stays cheap to run in the eval loop.
export default defineConfig({
  testDir: './generated',
  fullyParallel: false, // deterministic order matters for the eval's pass/fail counting
  reporter: [['list'], ['json', { outputFile: 'eval/last-run.json' }]],
  timeout: 15_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:4000',
  },
});
