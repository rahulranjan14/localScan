import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // Anything needing a live inference host is excluded by default. Tests that
    // only pass when a particular machine is awake are not tests -- they are a
    // reason people stop running the suite.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
})
