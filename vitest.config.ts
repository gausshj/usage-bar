import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig `paths` so tests can resolve `@/…` (used by API routes).
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // Cover the actual product paths (PRD §13.2), not the disconnected
      // security/workers modules that produced a misleading 100%.
      include: ['src/quota/**/*.ts', 'src/app/api/**/*.ts'],
      // TODO(#20): raise these to PRD targets (statements ≥ 85%, branches ≥ 80%)
      // once the remaining provider error-branch and route-contract tests land.
      // Set to current measured values so CI stays green without gaming.
      thresholds: {
        statements: 66,
        branches: 57,
        functions: 63,
        lines: 69,
      },
    },
  },
});
