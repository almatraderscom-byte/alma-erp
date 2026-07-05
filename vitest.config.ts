import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    // Several routing/contract tests import the FULL tool registry (~5s cold);
    // under parallel load that crosses the 5s default and flakes. 20s is a safe
    // ceiling that keeps genuinely-hung tests failing fast enough.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
