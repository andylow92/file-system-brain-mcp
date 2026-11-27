import { defineConfig } from 'vitest/config';

// Browser-level security tests for HTML previews: real Chromium via Playwright,
// driven from Node (not jsdom). Kept out of `npm test`; run `npm run test:browser`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['browser/**/*.browser.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
