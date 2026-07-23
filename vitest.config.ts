import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/main/**/*.test.ts',
      'src/shared/**/*.test.ts',
      'src/renderer/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    environment: 'node',
  },
})
