import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    // Anything needing a live inference host is excluded by default. Tests that
    // only pass when a particular machine is awake are not tests -- they are a
    // reason people stop running the suite.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    // Node for the engine, a DOM only where a component needs one.
    environmentMatchGlobs: [['packages/web/**', 'jsdom']],
    setupFiles: ['packages/web/src/test/setup.ts'],
  },
})
