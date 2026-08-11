import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * `generate` only. `push` is deliberately never used against anything but a
 * scratch database: migrations are reviewed SQL committed to the repository and
 * run as a DEPLOY STEP, never at application boot (Audit #1 F-13 — the legacy
 * system mutated its schema on every start, with errors swallowed).
 */
export default defineConfig({
  schema: './src/infrastructure/db/schema/index.ts',
  out: './src/infrastructure/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/arabtec_dev',
  },
  strict: true,
  verbose: true,
});
