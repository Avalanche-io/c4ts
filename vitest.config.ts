import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    globals: true,
    // scripts/skips.mjs shows the line that declared a skipped test.
    includeTaskLocation: true,
  },
})
