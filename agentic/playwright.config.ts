import { defineConfig } from '@playwright/test';

// API-only project — no browser project needed, so this stays cheap to run in the eval loop.
export default defineConfig({
  // Dynamically pick up every generated-suite directory (agentic/generated/,
  // agentic/generated-test/, or any future agentic/generated-*/) instead of hardcoding one
  // directory name, so a differently-named output location is still wired into the eval.
  testDir: '.',
  testMatch: 'generated*/**/*.spec.ts',
  fullyParallel: false, // deterministic order matters for the eval's pass/fail counting
  reporter: [['list'], ['json', { outputFile: 'eval/last-run.json' }]],
  timeout: 15_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:4000',
  },
});
