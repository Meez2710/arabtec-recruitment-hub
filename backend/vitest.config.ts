import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/modules/**/*.test.ts', 'src/infrastructure/**/*.test.ts', 'src/api/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['src/modules/**/*.ts', 'src/infrastructure/**/*.ts', 'src/api/**/*.ts'],
      exclude: [
        'src/modules/**/*.test.ts',
        'src/infrastructure/**/*.test.ts',
        'src/api/**/*.test.ts',
        // Process bootstrap: exercised by running it, not by unit tests.
        'src/api/main.ts',
        // CLI entry + DB drivers: exercised by running the tool, not unit tests.
        'src/infrastructure/tools/**/run.ts',
        'src/infrastructure/tools/**/source.ts',
        // Test scaffolding, not production code — its coverage is noise.
        'src/modules/**/__testing__/**',
        'src/infrastructure/db/testing/**',
        // Pure interface files compile to nothing; 0% is meaningless.
        'src/modules/**/ports/repositories.ts',
        'src/modules/**/ports/unit-of-work.ts',
        'src/modules/interview/application/ports.ts',
        'src/modules/shared/ports/notifications.ts',
        'src/modules/hiring/application/ports/offer-gateway.ts',
        'src/infrastructure/db/types.ts',
        'src/api/queries/ports.ts',
        'src/api/queries/talent-ports.ts',
        'src/api/queries/matching-ports.ts',
        'src/api/queries/search-ports.ts',
      ],
      // The domain layer is pure and must stay fully covered. This threshold is
      // the ratchet referenced in the test specification.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
