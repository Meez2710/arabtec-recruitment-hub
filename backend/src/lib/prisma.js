// NOTE: This file is intentionally a no-op placeholder.
//
// Phase 1 ships with a zero-dependency data layer built on Node's built-in
// `node:sqlite` (see ./db.js and ./models.js). The Prisma schema is retained
// at prisma/schema.prisma purely as the canonical, Postgres-ready data model
// (documentation + a drop-in for teams that prefer Prisma + PostgreSQL).
//
// To adopt Prisma + PostgreSQL instead of node:sqlite:
//   1. Set datasource provider = "postgresql" and DATABASE_URL in schema.prisma
//   2. `npx prisma generate && npx prisma migrate dev`
//   3. Replace the imports of ./models.js with Prisma client calls (same shape)
//
// Nothing imports this module at runtime.
export default null;
